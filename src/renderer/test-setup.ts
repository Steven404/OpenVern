import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest has no globals here, so Testing Library can't auto-register cleanup.
afterEach(cleanup);
