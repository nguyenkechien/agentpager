import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only unmounts automatically when `afterEach` is a global; vitest globals are off.
afterEach(() => {
  cleanup();
});
