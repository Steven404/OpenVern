import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('renderer test setup', () => {
  it('first test renders an element', () => {
    render(<p>leaked?</p>);
    expect(document.body.textContent).toContain('leaked?');
  });

  it('cleans up renders between tests without a manual cleanup call', () => {
    expect(document.body.textContent).toBe('');
  });
});
