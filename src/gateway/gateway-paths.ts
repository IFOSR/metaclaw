import { resolve } from 'path';

export function resolveGatewaySocketPath(metaclawDir: string): string {
  return resolve(metaclawDir, 'gateway.sock');
}
