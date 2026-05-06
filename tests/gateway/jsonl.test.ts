import { describe, expect, it } from 'vitest';
import { createJsonLineParser, encodeJsonLine } from '../../src/gateway/jsonl.js';
import { resolveGatewaySocketPath } from '../../src/gateway/gateway-paths.js';

describe('gateway jsonl protocol', () => {
  it('encodes messages as newline-delimited JSON', () => {
    expect(encodeJsonLine({ type: 'input', text: 'hello' })).toBe('{"type":"input","text":"hello"}\n');
  });

  it('parses messages across arbitrary chunks', () => {
    const messages: unknown[] = [];
    const parse = createJsonLineParser(message => messages.push(message));

    parse('{"type":"input"');
    parse(',"text":"hello"}\n{"type":"close"}\n');

    expect(messages).toEqual([
      { type: 'input', text: 'hello' },
      { type: 'close' },
    ]);
  });

  it('resolves the gateway socket inside the Metaclaw home directory', () => {
    expect(resolveGatewaySocketPath('/tmp/metaclaw-home')).toBe('/tmp/metaclaw-home/gateway.sock');
  });
});
