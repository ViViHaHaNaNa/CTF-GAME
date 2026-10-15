import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { testTimeout: 20000, include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts'] } });
