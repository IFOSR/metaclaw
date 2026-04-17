import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Static, Text, useInput } from 'ink';
import type { MetaclawSessionDeps, SessionSnapshot } from '../session/metaclaw-session.js';
import { MetaclawSession } from '../session/metaclaw-session.js';
import { prepareEditorSubmission } from '../session/session-helpers.js';

interface AppProps extends MetaclawSessionDeps {}

const EMPTY_SNAPSHOT: SessionSnapshot = {
  output: [],
  currentTaskId: null,
  runtimeState: {
    runningTaskId: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  },
};

export function App(props: AppProps) {
  const [editor, setEditor] = useState({ text: '', cursor: 0 });
  const editorRef = useRef({ text: '', cursor: 0 });
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(EMPTY_SNAPSHOT);
  const [committedOutput, setCommittedOutput] = useState<string[]>([]);
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
    if (snapshot.output.length !== committedOutput.length) {
      setCommittedOutput(snapshot.output);
    }
  }, [snapshot.output, committedOutput.length]);

  useInput(async (char, key) => {
    const editorState = editorRef.current;

    if (key.return) {
      if (!editorState.text.trim()) return;

      const { userInput, nextEditor } = prepareEditorSubmission(editorState);
      editorRef.current = nextEditor;
      setEditor(nextEditor);

      const result = await sessionRef.current!.submit(userInput);
      if (result.exitRequested) {
        setTimeout(() => process.exit(0), 100);
      }
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
      editorRef.current = next;
      setEditor(next);
    }
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Static items={committedOutput}>
          {(line, index) => <Text key={`${index}-${line}`}>{line}</Text>}
        </Static>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">当前执行: {snapshot.runtimeState.runningTaskId ? 1 : 0}</Text>
        <Text>待执行: {snapshot.runtimeState.readyTaskIds.length}</Text>
        <Text>已挂起: {snapshot.runtimeState.parkedTaskIds.length}</Text>
        <Text>阻塞: {snapshot.runtimeState.blockedTaskIds.length}</Text>
        <Text color="gray">最近事件: {snapshot.runtimeState.lastEvent ?? '无'}</Text>
      </Box>
      <Box>
        <>
          <Text color="green">&gt; </Text>
          <Text>{editor.text.slice(0, editor.cursor)}</Text>
          <Text inverse>{editor.text[editor.cursor] ?? ' '}</Text>
          <Text>{editor.text.slice(editor.cursor + 1)}</Text>
        </>
      </Box>
    </Box>
  );
}

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
