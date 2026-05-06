export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function createJsonLineParser<T>(onMessage: (message: T) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      onMessage(JSON.parse(line) as T);
    }
  };
}
