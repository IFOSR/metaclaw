import { createConnection } from 'net';
import { createInterface } from 'readline';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import type { GatewayClientMessage, GatewayServerMessage } from './protocol.js';

export async function runGatewayReadlineClient(socketPath: string): Promise<void> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const send = (message: GatewayClientMessage) => {
    socket.write(encodeJsonLine(message));
  };

  const parse = createJsonLineParser<GatewayServerMessage>((message) => {
    if (message.type === 'hello') {
      process.stdout.write(`→ 已连接 Metaclaw Gateway（session: ${message.sessionId}）\n`);
      readline.prompt();
      return;
    }
    if (message.type === 'output') {
      process.stdout.write(`${message.lines.join('\n')}\n`);
      readline.prompt();
      return;
    }
    if (message.type === 'error') {
      process.stdout.write(`错误：${message.message}\n`);
      readline.prompt();
      return;
    }
    if (message.type === 'exit') {
      readline.close();
      socket.end();
    }
  });

  socket.on('data', parse);
  socket.on('close', () => {
    readline.close();
  });
  socket.on('error', error => {
    process.stderr.write(`连接失败：${error.message}\n`);
    readline.close();
  });

  readline.on('line', line => {
    const text = line.trim();
    if (text === '/exit' || text === '/quit') {
      send({ type: 'close' });
      return;
    }
    if (text) {
      send({ type: 'input', text });
    }
    readline.prompt();
  });
}
