import React, { useEffect, useRef, useState } from 'react';
import { Box, render, Static, Text, useInput } from 'ink';
import { createConnection, type Socket } from 'net';
import { prepareEditorSubmission } from '../session/session-helpers.js';
import {
  COMPOSER_PANEL_BORDER_COLOR,
  META_TEXT_COLOR,
  PANEL_HEADER_COLOR,
  PROMPT_COLOR,
  RUNTIME_SUMMARY_COLOR,
  STATUS_PANEL_BORDER_COLOR,
  buildRenderLines,
  formatRenderLine,
  getLineColor,
} from '../tui/app.js';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import type { GatewayClientMessage, GatewayServerMessage } from './protocol.js';
import { runGatewayReadlineClient } from './readline-client.js';

type ConnectionStatus = 'connecting' | 'connected' | 'closed' | 'error';

interface GatewayClientAppProps {
  socketPath: string;
}

export function GatewayClientApp(props: GatewayClientAppProps) {
  const [editor, setEditor] = useState({ text: '', cursor: 0 });
  const editorRef = useRef({ text: '', cursor: 0 });
  const [output, setOutput] = useState<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = createConnection(props.socketPath);
    socketRef.current = socket;

    const parse = createJsonLineParser<GatewayServerMessage>((message) => {
      if (message.type === 'hello') {
        setSessionId(message.sessionId);
        setStatus('connected');
        setOutput(previous => [
          ...previous,
          `→ 已连接 Metaclaw Gateway（session: ${message.sessionId}）`,
        ]);
        return;
      }
      if (message.type === 'output') {
        setOutput(previous => [...previous, ...message.lines]);
        return;
      }
      if (message.type === 'error') {
        setOutput(previous => [...previous, `错误：${message.message}`]);
        return;
      }
      if (message.type === 'exit') {
        setStatus('closed');
        socket.end();
        setTimeout(() => process.exit(0), 100);
      }
    });

    socket.on('data', parse);
    socket.on('connect', () => setStatus('connected'));
    socket.on('close', () => setStatus(previous => previous === 'error' ? previous : 'closed'));
    socket.on('error', error => {
      setStatus('error');
      setOutput(previous => [...previous, `错误：Gateway 连接失败：${error.message}`]);
    });

    return () => {
      socket.destroy();
    };
  }, [props.socketPath]);

  const send = (message: GatewayClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.destroyed) {
      setOutput(previous => [...previous, '错误：Gateway 连接已断开']);
      return;
    }
    socket.write(encodeJsonLine(message));
  };

  useInput((char, key) => {
    const editorState = editorRef.current;

    if (key.return) {
      if (!editorState.text.trim()) return;

      const { userInput, nextEditor } = prepareEditorSubmission(editorState);
      editorRef.current = nextEditor;
      setEditor(nextEditor);

      if (userInput === '/exit' || userInput === '/quit') {
        send({ type: 'close' });
        return;
      }
      send({ type: 'input', text: userInput });
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

  const renderLines = buildRenderLines(output);
  const runtimeSummary = `模式 client | session ${sessionId ?? 'connecting'} | gateway ${props.socketPath}`;
  const latestEvent = `连接状态 ${status}`;

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
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={STATUS_PANEL_BORDER_COLOR} paddingX={1} marginBottom={1}>
        <Text color={PANEL_HEADER_COLOR} bold>运行状态</Text>
        <Text color={RUNTIME_SUMMARY_COLOR}>{runtimeSummary}</Text>
        <Text color={META_TEXT_COLOR}>{latestEvent}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={COMPOSER_PANEL_BORDER_COLOR} paddingX={1}>
        <Text color={PANEL_HEADER_COLOR} bold>当前输入</Text>
        <Text color={META_TEXT_COLOR}>status: client:{status}</Text>
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

export async function runGatewayClientUi(socketPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    await runGatewayReadlineClient(socketPath);
    return;
  }
  render(<GatewayClientApp socketPath={socketPath} />);
  await new Promise(() => undefined);
}
