export type CapabilityClass =
  | 'code_edit'
  | 'research'
  | 'messaging'
  | 'memory_ops'
  | 'office_automation'
  | 'conversation'
  | 'general';

export const CAPABILITY_CLASSES: readonly CapabilityClass[] = [
  'code_edit',
  'research',
  'messaging',
  'memory_ops',
  'office_automation',
  'conversation',
  'general',
] as const;

export function isCapabilityClass(value: unknown): value is CapabilityClass {
  return typeof value === 'string' && (CAPABILITY_CLASSES as readonly string[]).includes(value);
}
