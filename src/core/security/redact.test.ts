import { describe, expect, it } from 'vitest';
import { redactSecrets, sentinel } from './redact';

// Fixtures are assembled at runtime so no literal token-shaped string sits in the repo (secret scanners).
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const T = {
  openrouter: `sk-or-v1-${rep('0a1b2c3d', 64)}`,
  anthropic: `sk-ant-api03-${rep('Ab1_', 80)}`,
  openaiProj: `sk-proj-${rep('Xy9-', 40)}`,
  openaiLegacy: `sk-${rep('aB3', 48)}`,
  githubPat: `github_pat_${rep('11AB_cd', 60)}`,
  ghp: `ghp_${rep('aB1', 36)}`,
  ghs: `ghs_${rep('Zz9', 36)}`,
  gitlab: `glpat-${rep('Ab1-', 20)}`,
  slack: `xoxb-${rep('123-ab', 30)}`,
  aws: `AKIA${rep('ABC123', 16)}`,
  google: `AIza${rep('Sy1_-', 35)}`,
  groq: `gsk_${rep('aB1', 52)}`,
  xai: `xai-${rep('aB1', 40)}`,
  hf: `hf_${rep('aB1', 34)}`,
  stripe: `sk_live_${rep('aB1', 24)}`,
  npm: `npm_${rep('aB1', 36)}`,
};

describe('redactSecrets: vendor prefixes', () => {
  for (const [name, token] of Object.entries(T)) {
    it(`redacts a ${name} token`, () => {
      const { text, count } = redactSecrets(`before ${token} after\nKEY="${token}"`);
      expect(text).not.toContain(token);
      expect(text).toContain('«redacted:');
      expect(text.startsWith('before ')).toBe(true);
      expect(text).toContain(' after\nKEY="«redacted:');
      expect(count).toBe(2);
    });
  }

  it('keeps only the public prefix in the sentinel, never a tail', () => {
    expect(redactSecrets(T.openrouter).text).toBe(sentinel('sk-or-v1-…'));
    expect(redactSecrets(T.ghp).text).toBe(sentinel('ghp_…'));
    expect(redactSecrets(T.openaiProj).text).toBe(sentinel('sk-proj-…'));
    expect(redactSecrets(T.openrouter).text).not.toContain(T.openrouter.slice(-4));
  });

  it('redacts a key cut short by an output limit', () => {
    const cut = T.openrouter.slice(0, 17); // sk-or-v1- + 8 hex
    expect(redactSecrets(`x ${cut}`).text).toBe(`x ${sentinel('sk-or-v1-…')}`);
  });

  it('leaves look-alikes alone', () => {
    const benign = [
      'task-runner disk-usage risk-assessment-for-the-whole-team',
      'sk-some-very-long-css-class-name-here',
      'the ghp_ prefix marks GitHub tokens',
      `my_ghp_${rep('aB1', 36)}`,
      '123e4567-e89b-12d3-a456-426614174000',
      '1c38b41653f928ac44efde7df5588d70bdc9a12a',
      'hf_hub_download(repo_id, filename)',
      'sk-or-v1-',
    ].join('\n');
    expect(redactSecrets(benign)).toEqual({ text: benign, count: 0 });
  });

  it('is idempotent', () => {
    const once = redactSecrets(Object.values(T).join('\n')).text;
    expect(redactSecrets(once)).toEqual({ text: once, count: 0 });
  });
});

describe('redactSecrets: known values', () => {
  it('removes an exact value with no recognisable prefix, also inside a longer token', () => {
    const key = 'opaque-key-without-prefix-123';
    const { text, count } = redactSecrets(`{"value":"${key}"} x${key}y`, { known: [key] });
    expect(text).toBe(`{"value":"${sentinel('stored-key')}"} x${sentinel('stored-key')}y`);
    expect(count).toBe(2);
  });

  it('ignores known values too short to be meaningful', () => {
    expect(redactSecrets('a short abc', { known: ['abc', ''] }).count).toBe(0);
  });

  it('prefers the stored-key sentinel for the app key', () => {
    expect(redactSecrets(T.openrouter, { known: [T.openrouter] }).text).toBe(sentinel('stored-key'));
  });
});

describe('redactSecrets: PEM private keys', () => {
  const pem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    rep('b3BlbnNzaC1rZXktdjEAAAAA', 70),
    rep('QyNTUxOQAAACB', 70),
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  it('replaces the whole block and keeps the line count', () => {
    const input = `line1\n${pem}\nline6`;
    const { text, count } = redactSecrets(input);
    expect(count).toBe(1);
    expect(text).toBe(`line1\n${sentinel('private-key')}\n\n\n\nline6`);
    expect(text.split('\n')).toHaveLength(input.split('\n').length);
  });

  it('redacts a block cut before its END line to the end of the text', () => {
    const cut = pem.split('\n').slice(0, 2).join('\n');
    expect(redactSecrets(`a\n${cut}`).text).toBe(`a\n${sentinel('private-key')}\n`);
  });

  it('leaves public keys alone', () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----';
    expect(redactSecrets(pub).count).toBe(0);
  });
});
