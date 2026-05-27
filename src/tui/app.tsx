import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Static, Text, useInput } from 'ink';
import type { MetaclawSessionDeps, SessionSnapshot } from '../session/metaclaw-session.js';
import { MetaclawSession } from '../session/metaclaw-session.js';
import { prepareEditorSubmission } from '../session/session-helpers.js';
import { createFeishuBridge } from '../integrations/feishu-app.js';

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

const META_TEXT_COLOR = 'whiteBright';
const PANEL_HEADER_COLOR = 'whiteBright';
const RUNTIME_SUMMARY_COLOR = 'cyanBright';
const GUIDANCE_BORDER_COLOR = 'cyanBright';
const STATUS_PANEL_BORDER_COLOR = 'cyanBright';
const COMPOSER_PANEL_BORDER_COLOR = 'whiteBright';
const PROMPT_COLOR = 'greenBright';

const EMPTY_SNAPSHOT: SessionSnapshot = {
  output: [],
  currentTaskId: null,
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
    || recentOutput.includes('[y] 接受并继续恢复')
    || recentOutput.includes('[y] 全部采用')
    || recentOutput.includes('[f] 基于该任务创建 follow-up')
    || recentOutput.includes('输入“确认执行”继续')
    || recentOutput.includes('输入“取消执行”放弃');
}

function getComposerStatus(snapshot: SessionSnapshot, lines: string[], defaultExecutorName: string): string {
  if (hasPendingConfirmation(lines)) {
    return 'waiting_confirm';
  }

  if (snapshot.runtimeState.runningTaskId) {
    return `running ${snapshot.runtimeState.runningExecutorName ?? defaultExecutorName}`;
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

export function App(props: AppProps) {
  const [editor, setEditor] = useState({ text: '', cursor: 0 });
  const editorRef = useRef({ text: '', cursor: 0 });
  const inputHistoryRef = useRef<InputHistoryState>(createInputHistoryState());
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
    const session = sessionRef.current!;
    let stopped = false;
    let bridge;
    try {
      bridge = createFeishuBridge(props.config, session);
    } catch (error) {
      session.appendSystemMessage(`⚠️ 飞书应用桥接未启动: ${(error as Error).message}`);
      return;
    }

    if (!bridge) {
      return;
    }

    const feishuMode = props.config.integrations?.feishu?.mode ?? 'websocket';
    void bridge.start().then(() => {
      if (!stopped) {
        session.appendSystemMessage(
          feishuMode === 'webhook'
            ? '→ 飞书 Webhook 桥接已启动，等待飞书回调'
            : '→ 飞书长连接桥接已启动，等待飞书消息',
        );
      }
    }).catch(error => {
      session.appendSystemMessage(`⚠️ 飞书应用桥接启动失败: ${(error as Error).message}`);
    });

    return () => {
      stopped = true;
      void bridge.stop();
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

    return () => clearInterval(timer);
  }, [snapshot.runtimeState.runningTaskId]);

  useInput(async (char, key) => {
    const editorState = editorRef.current;
    lastInputAtRef.current = Date.now();

    if (key.return) {
      if (!editorState.text.trim()) return;

      const { userInput, nextEditor } = prepareEditorSubmission(editorState);
      inputHistoryRef.current = recordInputHistory(inputHistoryRef.current, userInput, nextEditor);
      editorRef.current = nextEditor;
      setEditor(nextEditor);

      const result = await sessionRef.current!.submit(userInput);
      if (result.exitRequested) {
        setTimeout(() => process.exit(0), 100);
      }
      return;
    }

    if (key.upArrow) {
      const next = recallPreviousInput(inputHistoryRef.current, editorState);
      inputHistoryRef.current = next.state;
      editorRef.current = next.editor;
      setEditor(next.editor);
      return;
    }

    if (key.downArrow) {
      const next = recallNextInput(inputHistoryRef.current, editorState);
      inputHistoryRef.current = next.state;
      editorRef.current = next.editor;
      setEditor(next.editor);
      return;
    }

    if (key.leftArrow) {
      const next = { ...editorState, cursor: Math.max(0, editorState.cursor - 1) };
      editorRef.current = next;
      setEditor(next);
      return;
    }

    if (key.rightArrow) {
      const next = { ...editorState, cursor: Math.min(editorState.text.length, editorState.cursor + 1) };
      editorRef.current = next;
      setEditor(next);
      return;
    }

    if (key.backspace || key.delete) {
      if (editorState.cursor > 0) {
        const next = {
          text: editorState.text.slice(0, editorState.cursor - 1) + editorState.text.slice(editorState.cursor),
          cursor: editorState.cursor - 1,
        };
        inputHistoryRef.current = resetInputHistoryBrowsing(inputHistoryRef.current, next);
        editorRef.current = next;
        setEditor(next);
      }
      return;
    }

    if (!key.ctrl && !key.meta && char) {
      const next = {
        text: editorState.text.slice(0, editorState.cursor) + char + editorState.text.slice(editorState.cursor),
        cursor: editorState.cursor + char.length,
      };
      inputHistoryRef.current = resetInputHistoryBrowsing(inputHistoryRef.current, next);
      editorRef.current = next;
      setEditor(next);
    }
  });

  const renderLines = buildRenderLines(committedOutput);
  const composerStatus = getComposerStatus(snapshot, committedOutput, props.executor.name);
  const runtimeSummary = `当前执行 ${snapshot.runtimeState.runningTaskId ? 1 : 0} | 待执行 ${snapshot.runtimeState.readyTaskIds.length} | 已挂起 ${snapshot.runtimeState.parkedTaskIds.length} | 阻塞 ${snapshot.runtimeState.blockedTaskIds.length}`;
  const latestEvent = `最近事件 ${snapshot.runtimeState.lastEvent ?? '0'}`;
  const waitingHintVisible = shouldShowWaitingHint(snapshot, committedOutput, showWaitingIndicator);

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
        <Text color={META_TEXT_COLOR}>{latestEvent}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={COMPOSER_PANEL_BORDER_COLOR} paddingX={1}>
        <Text color={PANEL_HEADER_COLOR} bold>当前输入</Text>
        <Text color={META_TEXT_COLOR}>status: {composerStatus}</Text>
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
