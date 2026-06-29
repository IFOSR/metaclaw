export type SafetyScanStatus = 'passed' | 'blocked';

export interface SafetyScanInput {
  title: string;
  content: string;
}

export interface SafetyScanResult {
  status: SafetyScanStatus;
  reasons: string[];
  redactedContent: string;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(api[_-]?key|token|password|secret)\s*=\s*[^\s]+/gi,
];

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bchmod\s+777\b/i,
  /\bcurl\b[^|\n]*\|\s*(?:sh|bash)\b/i,
];

export class SafetyScanner {
  scanCandidate(input: SafetyScanInput): SafetyScanResult {
    const reasons = new Set<string>();
    let redactedContent = input.content;

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(redactedContent)) {
        reasons.add('contains_secret');
        redactedContent = redactedContent.replace(pattern, '[REDACTED]');
      }
    }

    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(input.content)) {
        reasons.add('contains_dangerous_command');
      }
    }

    return {
      status: reasons.size > 0 ? 'blocked' : 'passed',
      reasons: Array.from(reasons),
      redactedContent,
    };
  }
}
