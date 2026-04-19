import { describe, expect, it } from 'vitest';
import { resolveMetaclawDir } from '../../src/utils/paths.js';

describe('resolveMetaclawDir', () => {
  it('uses METACLAW_HOME when provided', () => {
    expect(resolveMetaclawDir('./tmp/metaclaw-home', '/Users/demo')).toMatch(/tmp\/metaclaw-home$/);
  });

  it('falls back to ~/.metaclaw when override is missing', () => {
    expect(resolveMetaclawDir('', '/Users/demo')).toBe('/Users/demo/.metaclaw');
  });
});
