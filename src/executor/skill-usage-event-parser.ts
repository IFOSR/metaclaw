import type { SkillUsageEventType } from '../storage/skill-usage-event-repo.js';

export interface ParsedSkillUsageEvent {
  eventType: SkillUsageEventType;
  skillName: string;
  skillVersion: string | null;
  message: string;
  payload: Record<string, unknown>;
}

const PREFIX = 'METACLAW_SKILL_EVENT ';
const SUPPORTED_TYPES = new Set<SkillUsageEventType>([
  'skill_started',
  'skill_step_started',
  'skill_step_completed',
  'skill_progress',
  'skill_completed',
  'skill_failed',
  'skill_skipped',
  'skill_suggested_patch',
]);

const SECRET_KEY_PATTERN = /(api[_-]?key|token|password|secret|credential|connection[_-]?string)/i;
const SECRET_TEXT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSkillUsageEventText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match, key) => {
      if (typeof key === 'string' && key.length > 0 && /[:=]/.test(match)) {
        const separator = match.includes('=') ? '=' : ':';
        return `${key}${separator}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return redacted;
}

export function redactSkillUsageEventPayload(value: unknown): Record<string, unknown> {
  const redacted = redactUnknown(value);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return {};
}

function redactUnknown(value: unknown, keyHint = ''): unknown {
  if (SECRET_KEY_PATTERN.test(keyHint)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactSkillUsageEventText(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactUnknown(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactUnknown(nested, key);
    }
    return result;
  }
  return value;
}

export function parseSkillUsageEventLine(line: string): ParsedSkillUsageEvent | null {
  if (!line.startsWith(PREFIX)) {
    return null;
  }

  try {
    const raw = JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
    const eventType = raw.type;
    const skillName = raw.skillName;
    if (typeof eventType !== 'string' || !SUPPORTED_TYPES.has(eventType as SkillUsageEventType)) {
      return null;
    }
    if (typeof skillName !== 'string' || skillName.trim().length === 0) {
      return null;
    }

    return {
      eventType: eventType as SkillUsageEventType,
      skillName,
      skillVersion: typeof raw.skillVersion === 'string' ? raw.skillVersion : null,
      message: redactSkillUsageEventText(typeof raw.message === 'string' ? raw.message : ''),
      payload: redactSkillUsageEventPayload(raw.payload),
    };
  } catch {
    return null;
  }
}
