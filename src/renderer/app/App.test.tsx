import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => vi.unstubAllEnvs());

describe('App placeholder', () => {
  it('renders the logo and reports API health from the mock client', async () => {
    vi.stubEnv('VITE_API', 'mock');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'harness.' })).toBeTruthy();
    expect(await screen.findByText(/API dev/)).toBeTruthy();
  });
});
