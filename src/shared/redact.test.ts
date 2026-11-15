import * as shared from '@shared/redact';
import { describe, expect, it } from 'vitest';
import * as core from '../core/security/redact';

// The core path is a re-export of `@shared/redact` (terminal plan §4.5); the suite in
// `src/core/security/redact.test.ts` covers the behaviour in depth. This file only proves the new path resolves to the
// same module and still redacts, so neither path drifts.

// Assembled at runtime so no literal token-shaped string sits in the repo (secret scanners).
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

describe('redactSecrets: shared path', () => {
  it('is the same module through both import paths', () => {
    expect(core.redactSecrets).toBe(shared.redactSecrets);
    expect(core.sentinel).toBe(shared.sentinel);
    expect(core.SECRET_PATTERNS).toBe(shared.SECRET_PATTERNS);
    expect(core.redactionNote).toBe(shared.redactionNote);
  });

  it('redacts a vendor token and a known value through @shared/redact', () => {
    const token = `sk-or-v1-${rep('0a1b2c3d', 64)}`;
    const known = 'opaque-key-without-prefix-123';
    const { text, count } = shared.redactSecrets(`before ${token} and ${known} after`, { known: [known] });
    expect(count).toBe(2);
    expect(text).not.toContain(token);
    expect(text).not.toContain(known);
    expect(text).toContain(shared.sentinel('sk-or-v1-…'));
    expect(text).toContain(shared.sentinel('stored-key'));
  });

  it('keeps the line breaks of a redacted PEM block', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      rep('b3BlbnNzaC1rZXktdjEAAAAA', 70),
      rep('QyNTUxOQAAACB', 70),
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const input = `line1\n${pem}\nline6`;
    const { text, count } = shared.redactSecrets(input);
    expect(count).toBe(1);
    expect(text).toBe(`line1\n${shared.sentinel('private-key')}\n\n\n\nline6`);
    expect(text.split('\n')).toHaveLength(input.split('\n').length);
  });
});
