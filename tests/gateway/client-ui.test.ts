import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'events';
import { GatewayClientApp } from '../../src/gateway/client-ui.js';

const inputCapture = vi.hoisted(() => ({
  handler: undefined as undefined | ((input: string, key: Record<string, boolean>) => void),
}));

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  end(): void {
    this.destroyed = true;
    this.emit('close');
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const socketState = vi.hoisted(() => ({
  socket: null as FakeSocket | null,
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
      inputCapture.handler = handler;
    },
  };
});

vi.mock('net', () => ({
  createConnection: () => {
    const socket = new FakeSocket();
    socketState.socket = socket;
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  },
}));

function flushUpdates() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
  inputCapture.handler = undefined;
  socketState.socket = null;
});

describe('GatewayClientApp', () => {
  it('renders a Metaclaw-like TUI with an explicit client marker', async () => {
    const app = render(React.createElement(GatewayClientApp, { socketPath: '/tmp/metaclaw.sock' }));
    await flushUpdates();

    socketState.socket?.emit('data', Buffer.from('{"type":"hello","sessionId":"sess_gateway_test"}\n'));
    await flushUpdates();

    expect(app.lastFrame()).toContain('运行状态');
    expect(app.lastFrame()).toContain('模式 client | session sess_gateway_test | gateway /tmp/metaclaw.sock');
    expect(app.lastFrame()).toContain('status: client:connected');
    expect(app.lastFrame()).toContain('当前输入');

    app.unmount();
    app.cleanup();
  });

  it('sends typed input to the gateway socket', async () => {
    const app = render(React.createElement(GatewayClientApp, { socketPath: '/tmp/metaclaw.sock' }));
    await flushUpdates();

    inputCapture.handler?.('h', {});
    inputCapture.handler?.('i', {});
    inputCapture.handler?.('', { return: true });

    expect(socketState.socket?.writes).toContain('{"type":"input","text":"hi"}\n');

    app.unmount();
    app.cleanup();
  });
});
