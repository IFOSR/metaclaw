import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Static, Text, useInput } from 'ink';
import type { MetaclawSessionDeps, SessionSnapshot } from '../session/metaclaw-session.js';
import { createDefaultCommandRouter, MetaclawSession } from '../session/metaclaw-session.js';
import { prepareEditorSubmission } from '../session/session-helpers.js';
import { startFeishuRuntimeBridge } from '../gateway/feishu-runtime.js';
import type { CommandHandler } from '../commands/router.js';

interface AppProps extends MetaclawSessionDeps {}

type OutputKind = 'blank' | 'user' | 'system' | 'context' | 'agent' | 'result' | 'warning';

interface RenderLine {
  kind: OutputKind;
  text: string;
  indent: number;
}

interface EditorState {
  text: string;
  cursor: number;
}

interface InputHistoryState {
  entries: string[];
  cursor: number | null;
  draft: EditorState;
}

interface CommandSuggestion {
  command: string;
  aliases: string[];
  description: string;
}

interface EditorInputKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  forwardDelete?: boolean;
  return?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
}

const META_TEXT_COLOR = 'whiteBright';
const PANEL_HEADER_COLOR = 'whiteBright';
const RUNTIME_SUMMARY_COLOR = 'cyanBright';
const GUIDANCE_BORDER_COLOR = 'cyanBright';
const STATUS_PANEL_BORDER_COLOR = 'cyanBright';
const COMPOSER_PANEL_BORDER_COLOR = 'whiteBright';
const PROMPT_COLOR = 'greenBright';
const SUGGESTION_BORDER_COLOR = 'cyanBright';
const SUGGESTION_SELECTED_COLOR = 'black';
const SUGGESTION_LIMIT = 6;
const COMMAND_SUGGESTION_PRIORITY = new Map([
  ['/task', 0],
  ['/tasks', 1],
  ['/memory', 2],
  ['/executor', 3],
  ['/dashboard', 4],
  ['/help', 5],
]);

const COMMAND_SUGGESTIONS: CommandSuggestion[] = createCommandSuggestions(createDefaultCommandRouter().listHandlers());

const EMPTY_SNAPSHOT: SessionSnapshot = {
  output: [],
  currentTaskId: null,
  currentTask: null,
  runtimeState: {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  },
  latestGuidance: null,
};

function isResultBoundary(line: string): boolean {
  return line.startsWith('→ 已记录 ')
    || line.startsWith('┌─ 操作指引')
    || line.startsWith('💡 ')
    || line.startsWith('⚠️ ')
    || line.startsWith('> ');
}

function normalizeWarningLine(line: string): string {
  if (line.startsWith('✗ ')) {
    return `! ${line.slice(2)}`;
  }

  if (line.startsWith('错误')) {
    return `! ${line}`;
  }

  return line;
}

function classifyOutputLine(line: string, inResultBlock: boolean): RenderLine {
  if (!line.trim()) {
    return {
      kind: 'blank',
      text: '',
      indent: 0,
    };
  }

  if (line.startsWith('> ')) {
    return { kind: 'user', text: line, indent: 0 };
  }

  if (line.startsWith('✓ ')) {
    return { kind: 'result', text: line, indent: 0 };
  }

  if (line.startsWith('✗ ') || line.startsWith('⚠️ ') || line.startsWith('错误') || line.startsWith('确认失败')) {
    return {
      kind: 'warning',
      text: normalizeWarningLine(line),
      indent: 0,
    };
  }

  if (line.startsWith('┌─ 任务结果') || line.startsWith('│ 摘要') || line.startsWith('│ 下一步') || (inResultBlock && line.startsWith('└'))) {
    return { kind: 'result', text: line, indent: 0 };
  }

  if (inResultBlock && !isResultBoundary(line)) {
    return { kind: 'result', text: line, indent: 0 };
  }

  if (line.startsWith('→ 已注入 ')) {
    return {
      kind: 'context',
      text: `· ${line.replace(/^→ /, '')}`,
      indent: 1,
    };
  }

  if (line.startsWith('   - ')) {
    return {
      kind: 'context',
      text: `· ${line.trim().replace(/^- /, '')}`,
      indent: 2,
    };
  }

  if (
    line === '【提取最近历史记录上下文】'
    || line === '【构建执行上下文】'
    || line === '【执行上下文准备完成】'
  ) {
    return { kind: 'context', text: line, indent: 0 };
  }

  if (line.startsWith('· #')) {
    return { kind: 'agent', text: line, indent: 0 };
  }

  if (line.startsWith('任务 #')) {
    return { kind: 'system', text: `→ ${line}`, indent: 0 };
  }

  if (
    line.startsWith('→ ')
    || line.startsWith('┌─ ')
    || line.startsWith('│ ')
    || line.startsWith('└')
    || line.startsWith('已记住')
    || line.startsWith('已确认')
    || line.startsWith('已忽略')
    || line.startsWith('请输入 ')
    || line.startsWith('未找到')
    || line.startsWith('当前没有')
  ) {
    return { kind: 'system', text: line, indent: 0 };
  }

  return { kind: 'system', text: line, indent: 0 };
}

function shouldInsertUserTurnSeparator(previous: RenderLine | undefined, next: RenderLine): boolean {
  return next.kind === 'user'
    && previous !== undefined
    && previous.kind !== 'blank';
}

function buildRenderLines(lines: string[]): RenderLine[] {
  let inResultBlock = false;
  const rendered: RenderLine[] = [];

  for (const line of lines) {
    if (line.startsWith('✓ ')) {
      inResultBlock = true;
    } else if (inResultBlock && isResultBoundary(line)) {
      inResultBlock = false;
    }

    const renderLine = classifyOutputLine(line, inResultBlock);
    if (shouldInsertUserTurnSeparator(rendered[rendered.length - 1], renderLine)) {
      rendered.push({
        kind: 'blank',
        text: '',
        indent: 0,
      });
    }
    rendered.push(renderLine);
  }

  return rendered;
}

function getLineColor(kind: OutputKind): string | undefined {
  switch (kind) {
    case 'user':
      return 'greenBright';
    case 'system':
      return 'whiteBright';
    case 'context':
      return 'cyanBright';
    case 'agent':
      return 'blueBright';
    case 'result':
      return 'greenBright';
    case 'warning':
      return 'yellowBright';
    default:
      return undefined;
  }
}

function formatRenderLine(line: RenderLine): string {
  if (line.kind === 'blank') {
    return ' ';
  }

  return `${'  '.repeat(line.indent)}${line.text}`;
}

function hasPendingConfirmation(lines: string[]): boolean {
  const recentOutput = lines.slice(-8).join('\n');
  return recentOutput.includes('[y] 确认')
    || recentOutput.includes('确认执行');
}

function getComposerStatus(
  snapshot: SessionSnapshot,
  lines: string[],
  defaultExecutorName: string,
  isSubmitting: boolean,
): string {
  if (hasPendingConfirmation(lines)) {
    return 'legacy_confirm_clearing';
  }

  if (snapshot.runtimeState.runningTaskId) {
    return `running ${snapshot.runtimeState.runningExecutorName ?? defaultExecutorName}`;
  }

  if (isSubmitting) {
    return 'processing';
  }

  if (snapshot.runtimeState.blockedTaskIds.length > 0) {
    return 'blocked';
  }

  return 'idle';
}

function shouldShowWaitingHint(snapshot: SessionSnapshot, lines: string[], showWaitingIndicator: boolean): boolean {
  if (!snapshot.runtimeState.runningTaskId) {
    return false;
  }

  const lastMeaningfulLine = [...lines].reverse().find(line => line.trim().length > 0);
  if (!lastMeaningfulLine) {
    return false;
  }

  return showWaitingIndicator
    || lastMeaningfulLine.startsWith('→ 正在执行任务')
    || lastMeaningfulLine.startsWith('→ 派发给');
}

function createInputHistoryState(): InputHistoryState {
  return {
    entries: [],
    cursor: null,
    draft: { text: '', cursor: 0 },
  };
}

function recordInputHistory(state: InputHistoryState, userInput: string, nextEditor: EditorState): InputHistoryState {
  const entries = state.entries[state.entries.length - 1] === userInput
    ? state.entries
    : [...state.entries, userInput].slice(-100);
  return {
    entries,
    cursor: null,
    draft: nextEditor,
  };
}

function recallPreviousInput(state: InputHistoryState, currentEditor: EditorState): {
  state: InputHistoryState;
  editor: EditorState;
} {
  if (state.entries.length === 0) {
    return { state, editor: currentEditor };
  }

  const cursor = state.cursor === null
    ? state.entries.length - 1
    : Math.max(0, state.cursor - 1);
  const text = state.entries[cursor] ?? '';
  return {
    state: {
      ...state,
      cursor,
      draft: state.cursor === null ? currentEditor : state.draft,
    },
    editor: { text, cursor: text.length },
  };
}

function recallNextInput(state: InputHistoryState, currentEditor: EditorState): {
  state: InputHistoryState;
  editor: EditorState;
} {
  if (state.cursor === null) {
    return { state, editor: currentEditor };
  }

  if (state.cursor >= state.entries.length - 1) {
    return {
      state: {
        ...state,
        cursor: null,
      },
      editor: state.draft,
    };
  }

  const cursor = state.cursor + 1;
  const text = state.entries[cursor] ?? '';
  return {
    state: {
      ...state,
      cursor,
    },
    editor: { text, cursor: text.length },
  };
}

function resetInputHistoryBrowsing(state: InputHistoryState, editor: EditorState): InputHistoryState {
  return {
    ...state,
    cursor: null,
    draft: editor,
  };
}

function createCommandSuggestions(handlers: CommandHandler[]): CommandSuggestion[] {
  return handlers
    .map(handler => ({
      command: `/${handler.name}`,
      aliases: handler.aliases.map(alias => `/${alias}`),
      description: handler.description,
    }))
    .sort((left, right) => {
      const leftPriority = COMMAND_SUGGESTION_PRIORITY.get(left.command) ?? 100;
      const rightPriority = COMMAND_SUGGESTION_PRIORITY.get(right.command) ?? 100;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.command.localeCompare(right.command);
    });
}

function getSlashCommandQuery(editor: EditorState): string | null {
  if (!editor.text.startsWith('/')) {
    return null;
  }

  const beforeCursor = editor.text.slice(0, editor.cursor);
  if (/\s/.test(beforeCursor)) {
    return null;
  }

  return beforeCursor.slice(1).toLowerCase();
}

function getCommandSuggestions(editor: EditorState): CommandSuggestion[] {
  const query = getSlashCommandQuery(editor);
  if (query === null) {
    return [];
  }

  return COMMAND_SUGGESTIONS
    .filter(suggestion =>
      suggestion.command.slice(1).toLowerCase().startsWith(query)
      || suggestion.aliases.some(alias => alias.slice(1).toLowerCase().startsWith(query))
    )
    .slice(0, SUGGESTION_LIMIT);
}

function clampSuggestionIndex(index: number, suggestions: CommandSuggestion[]): number {
  if (suggestions.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, suggestions.length - 1));
}

function applyCommandSuggestion(editor: EditorState, suggestion: CommandSuggestion): EditorState {
  const suffix = editor.text.slice(editor.cursor);
  const text = `${suggestion.command} ${suffix.replace(/^\s*/, '')}`;
  const cursor = suggestion.command.length + 1;
  return { text, cursor };
}

function clampEditorCursor(editor: EditorState): EditorState {
  return {
    text: editor.text,
    cursor: Math.max(0, Math.min(editor.cursor, editor.text.length)),
  };
}

function insertEditorText(editor: EditorState, textToInsert: string): EditorState {
  const current = clampEditorCursor(editor);
  return {
    text: current.text.slice(0, current.cursor) + textToInsert + current.text.slice(current.cursor),
    cursor: current.cursor + textToInsert.length,
  };
}

function applyEditorInput(editor: EditorState, char: string, key: EditorInputKey): EditorState {
  const current = clampEditorCursor(editor);

  if (char === '\u007f' || char === '\b') {
    if (current.cursor === 0) {
      return current;
    }
    return {
      text: current.text.slice(0, current.cursor - 1) + current.text.slice(current.cursor),
      cursor: current.cursor - 1,
    };
  }

  if (key.leftArrow) {
    return { ...current, cursor: Math.max(0, current.cursor - 1) };
  }

  if (key.rightArrow) {
    return { ...current, cursor: Math.min(current.text.length, current.cursor + 1) };
  }

  if (key.backspace || key.delete) {
    if (current.cursor === 0) {
      return current;
    }
    return {
      text: current.text.slice(0, current.cursor - 1) + current.text.slice(current.cursor),
      cursor: current.cursor - 1,
    };
  }

  if (key.forwardDelete) {
    if (current.cursor >= current.text.length) {
      return current;
    }
    return {
      text: current.text.slice(0, current.cursor) + current.text.slice(current.cursor + 1),
      cursor: current.cursor,
    };
  }

  if (key.return && (key.shift || key.meta || key.ctrl)) {
    return insertEditorText(current, '\n');
  }

  if (key.ctrl && char === 'j') {
    return insertEditorText(current, '\n');
  }

  if (!key.ctrl && !key.meta && char) {
    return insertEditorText(current, char);
  }

  return current;
}

function applyEditorInputChunk(editor: EditorState, chunk: string): EditorState {
  let next = editor;
  let index = 0;

  while (index < chunk.length) {
    if (chunk.startsWith('\u001b[D', index)) {
      next = applyEditorInput(next, '', { leftArrow: true });
      index += 3;
      continue;
    }

    if (chunk.startsWith('\u001b[C', index)) {
      next = applyEditorInput(next, '', { rightArrow: true });
      index += 3;
      continue;
    }

    if (chunk.startsWith('\u001b[3~', index)) {
      next = applyEditorInput(next, '', { forwardDelete: true });
      index += 4;
      continue;
    }

    const char = chunk[index]!;
    if (char === '\u007f' || char === '\b') {
      next = applyEditorInput(next, '', { backspace: true });
      index += 1;
      continue;
    }

    if (char === '\n') {
      next = applyEditorInput(next, 'j', { ctrl: true });
      index += 1;
      continue;
    }

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\u001b') {
      const escapeMatch = chunk.slice(index).match(/^\u001b\[[0-9;]*[~A-Za-z]/);
      index += escapeMatch?.[0].length ?? 1;
      continue;
    }

    next = applyEditorInput(next, char, {});
    index += 1;
  }

  return next;
}

export function App(props: AppProps) {
  const [editor, setEditor] = useState({ text: '', cursor: 0 });
  const editorRef = useRef({ text: '', cursor: 0 });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputHistoryRef = useRef<InputHistoryState>(createInputHistoryState());
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const suggestionIndexRef = useRef(0);
  const lastInputAtRef = useRef(Date.now());
  const lastOutputAtRef = useRef(Date.now());
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(EMPTY_SNAPSHOT);
  const [committedOutput, setCommittedOutput] = useState<string[]>([]);
  const [showWaitingIndicator, setShowWaitingIndicator] = useState(false);
  const sessionRef = useRef<MetaclawSession | null>(null);

  if (!sessionRef.current) {
    sessionRef.current = new MetaclawSession(props);
  }

  useEffect(() => {
    const session = sessionRef.current!;
    const unsubscribe = session.subscribe(setSnapshot);
    session.initialize();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const session = sessionRef.current!;
    let stopped = false;
    let runtimeBridge: Awaited<ReturnType<typeof startFeishuRuntimeBridge>> = null;
    void startFeishuRuntimeBridge(props.config, session).then(startedBridge => {
      if (stopped) {
        void startedBridge?.stop();
        return;
      }
      runtimeBridge = startedBridge;
    });

    return () => {
      stopped = true;
      void runtimeBridge?.stop();
    };
  }, [props.config]);

  useEffect(() => {
    if (snapshot.output.length !== committedOutput.length) {
      setCommittedOutput(snapshot.output);
    }
  }, [snapshot.output, committedOutput.length]);

  useEffect(() => {
    lastOutputAtRef.current = Date.now();
    setShowWaitingIndicator(false);
  }, [committedOutput]);

  useEffect(() => {
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      if (editorRef.current.text.trim().length > 0) return;
      if (Date.now() - lastInputAtRef.current < 2_000) return;
      session.maybeEmitIdleGuidance();
    }, 1_000);
    timer.unref?.();

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const session = sessionRef.current!;
    const timer = setInterval(() => {
      void session.maybeReviewTaskPoolOnTimer().catch(error => {
        session.appendSystemMessage(`错误: ${(error as Error).message}`);
      });
    }, session.getBlockedRecheckIntervalMs());
    timer.unref?.();

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const isRunning = Boolean(snapshot.runtimeState.runningTaskId);
      if (!isRunning) {
        setShowWaitingIndicator(false);
        return;
      }

      const shouldShow = Date.now() - lastOutputAtRef.current >= 80;
      setShowWaitingIndicator(previous => (previous === shouldShow ? previous : shouldShow));
    }, 50);
    timer.unref?.();

    return () => clearInterval(timer);
  }, [snapshot.runtimeState.runningTaskId]);

  useInput(async (char, key) => {
    const editorState = editorRef.current;
    const commandSuggestions = getCommandSuggestions(editorState);
    const hasCommandSuggestions = commandSuggestions.length > 0;
    lastInputAtRef.current = Date.now();

    const commitEditor = async (editorToCommit: EditorState) => {
      if (!editorToCommit.text.trim()) return;

      const { userInput, nextEditor } = prepareEditorSubmission(editorToCommit);
      inputHistoryRef.current = recordInputHistory(inputHistoryRef.current, userInput, nextEditor);
      suggestionIndexRef.current = 0;
      setSuggestionIndex(0);
      editorRef.current = nextEditor;
      setEditor(nextEditor);

      setIsSubmitting(true);
      try {
        const result = await sessionRef.current!.submit(userInput);
        if (result.exitRequested) {
          setTimeout(() => process.exit(0), 100);
        }
      } finally {
        setIsSubmitting(false);
      }
    };

    const rawSubmitIndex = !key.shift && !key.meta && !key.ctrl
      ? Math.min(
          ...[char.indexOf('\r'), char.indexOf('\n')]
            .filter(index => index >= 0),
        )
      : -1;
    if (rawSubmitIndex >= 0 && Number.isFinite(rawSubmitIndex)) {
      const beforeSubmit = char.slice(0, rawSubmitIndex);
      const next = applyEditorInputChunk(editorState, beforeSubmit);
      inputHistoryRef.current = resetInputHistoryBrowsing(inputHistoryRef.current, next);
      suggestionIndexRef.current = 0;
      setSuggestionIndex(0);
      editorRef.current = next;
      setEditor(next);
      await commitEditor(next);
      return;
    }

    if (key.return) {
      if (key.shift || key.meta || key.ctrl) {
        const next = applyEditorInput(editorState, char, key);
        inputHistoryRef.current = resetInputHistoryBrowsing(inputHistoryRef.current, next);
        suggestionIndexRef.current = 0;
        setSuggestionIndex(0);
        editorRef.current = next;
        setEditor(next);
        return;
      }

      if (hasCommandSuggestions) {
        const selected = commandSuggestions[clampSuggestionIndex(suggestionIndexRef.current, commandSuggestions)];
        if (selected) {
          const next = applyCommandSuggestion(editorState, selected);
          inputHistoryRef.current = resetInputHistoryBrowsing(inputHistoryRef.current, next);
          suggestionIndexRef.current = 0;
          setSuggestionIndex(0);
          editorRef.current = next;
          setEditor(next);
        }
        return;
      }

      await commitEditor(editorState);
      return;
    }

    if (key.upArrow) {
      if (hasCommandSuggestions) {
        const nextIndex = suggestionIndexRef.current <= 0
          ? commandSuggestions.length - 1
          : suggestionIndexRef.current - 1;
        suggestionIndexRef.current = nextIndex;
        setSuggestionIndex(nextIndex);
        return;
      }

      const next = recallPreviousInput(inputHistoryRef.current, editorState);
      inputHistoryRef.current = next.state;
      suggestionIndexRef.current = 0;
      setSuggestionIndex(0);
      editorRef.current = next.editor;
      setEditor(next.editor);
      return;
    }

    if (key.downArrow) {
      if (hasCommandSuggestions) {
        const nextIndex = suggestionIndexRef.current >= commandSuggestions.length - 1
          ? 0
          : suggestionIndexRef.current + 1;
        suggestionIndexRef.current = nextIndex;
        setSuggestionIndex(nextIndex);
        return;
      }

      const next = recallNextInput(inputHistoryRef.current, editorState);
      inputHistoryRef.current = next.state;
      suggestionIndexRef.current = 0;
      setSuggestionIndex(0);
      editorRef.current = next.editor;
      setEditor(next.editor);
      return;
    }

    if (key.leftArrow || key.rightArrow || key.backspace || key.delete || char) {
      const next = char.length > 1
        ? applyEditorInputChunk(editorState, char)
        : applyEditorInput(editorState, char, key);
      inputHistoryRef.current = resetInputHistoryBrowsing(inputHistoryRef.current, next);
      suggestionIndexRef.current = 0;
      setSuggestionIndex(0);
      editorRef.current = next;
      setEditor(next);
      return;
    }
  });

  const renderLines = buildRenderLines(committedOutput);
  const composerStatus = getComposerStatus(snapshot, committedOutput, props.executor.name, isSubmitting);
  const runtimeSummary = `当前执行 ${snapshot.runtimeState.runningTaskId ? 1 : 0} | 待执行 ${snapshot.runtimeState.readyTaskIds.length} | 已挂起 ${snapshot.runtimeState.parkedTaskIds.length} | 阻塞 ${snapshot.runtimeState.blockedTaskIds.length}`;
  const latestEvent = `最近事件 ${snapshot.runtimeState.lastEvent ?? '0'}`;
  const waitingHintVisible = shouldShowWaitingHint(snapshot, committedOutput, showWaitingIndicator);
  const commandSuggestions = getCommandSuggestions(editor);
  const activeSuggestionIndex = clampSuggestionIndex(suggestionIndex, commandSuggestions);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Static items={renderLines}>
          {(line, index) => (
            <Text key={`${index}-${line.kind}-${line.text}`} color={getLineColor(line.kind)}>
              {formatRenderLine(line)}
            </Text>
          )}
        </Static>
        {waitingHintVisible && (
          <Text color={META_TEXT_COLOR}>  · 正在等待执行器返回...</Text>
        )}
      </Box>
      {snapshot.latestGuidance && (
        <Box flexDirection="column" borderStyle="round" borderColor={GUIDANCE_BORDER_COLOR} paddingX={1} marginBottom={1}>
          <Text color={PANEL_HEADER_COLOR} bold>当前建议</Text>
          <Text>场景: {snapshot.latestGuidance.scene}</Text>
          <Text>动作: {snapshot.latestGuidance.recommendedAction}</Text>
          <Text>任务: #{snapshot.latestGuidance.taskId}{snapshot.latestGuidance.taskTitle ? ` ${snapshot.latestGuidance.taskTitle}` : ''}</Text>
          {snapshot.latestGuidance.reasons.map((reason, index) => (
            <Text key={`${snapshot.latestGuidance!.taskId}-reason-${index}`}>原因{index + 1}: {reason}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" borderStyle="round" borderColor={STATUS_PANEL_BORDER_COLOR} paddingX={1} marginBottom={1}>
        <Text color={PANEL_HEADER_COLOR} bold>运行状态</Text>
        <Text color={RUNTIME_SUMMARY_COLOR}>{runtimeSummary}</Text>
        {snapshot.currentTask && (
          <Text color={META_TEXT_COLOR}>当前任务 #{snapshot.currentTask.id} [{snapshot.currentTask.status.toUpperCase()}] {snapshot.currentTask.title}</Text>
        )}
        <Text color={META_TEXT_COLOR}>{latestEvent}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={COMPOSER_PANEL_BORDER_COLOR} paddingX={1}>
        <Text color={PANEL_HEADER_COLOR} bold>当前输入</Text>
        <Text color={META_TEXT_COLOR}>status: {composerStatus}</Text>
        {commandSuggestions.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor={SUGGESTION_BORDER_COLOR} paddingX={1} marginBottom={1}>
            <Text color={PANEL_HEADER_COLOR} bold>命令建议 ↑/↓ 选择，Enter 录入</Text>
            {commandSuggestions.map((suggestion, index) => {
              const selected = index === activeSuggestionIndex;
              const aliasText = suggestion.aliases.length > 0 ? ` (${suggestion.aliases.join(', ')})` : '';
              return (
                <Text
                  key={suggestion.command}
                  color={selected ? SUGGESTION_SELECTED_COLOR : META_TEXT_COLOR}
                  backgroundColor={selected ? SUGGESTION_BORDER_COLOR : undefined}
                >
                  {selected ? '› ' : '  '}{suggestion.command}{aliasText} — {suggestion.description}
                </Text>
              );
            })}
          </Box>
        )}
        <Box>
          <Text color={PROMPT_COLOR} bold>&gt; </Text>
          <Text color={META_TEXT_COLOR}>{editor.text.slice(0, editor.cursor)}</Text>
          <Text inverse>{editor.text[editor.cursor] ?? ' '}</Text>
          <Text color={META_TEXT_COLOR}>{editor.text.slice(editor.cursor + 1)}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export {
  COMPOSER_PANEL_BORDER_COLOR,
  GUIDANCE_BORDER_COLOR,
  META_TEXT_COLOR,
  PANEL_HEADER_COLOR,
  PROMPT_COLOR,
  RUNTIME_SUMMARY_COLOR,
  STATUS_PANEL_BORDER_COLOR,
  getCommandSuggestions,
  applyCommandSuggestion,
  applyEditorInput,
  applyEditorInputChunk,
  getComposerStatus,
  buildRenderLines,
  formatRenderLine,
  getLineColor,
  createInputHistoryState,
  recallNextInput,
  recallPreviousInput,
  recordInputHistory,
};

export {
  parseExplicitRemember,
  prepareEditorSubmission,
  parsePriorityHint,
  buildSchedulingReason,
  planTaskExecution,
} from '../session/session-helpers.js';

export function renderApp(props: AppProps) {
  render(<App {...props} />);
}
