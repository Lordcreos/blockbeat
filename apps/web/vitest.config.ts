import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['lib/**/*.test.ts', 'lib/**/*.test.tsx', 'app/**/*.test.ts', 'components/**/*.test.ts', 'components/**/*.test.tsx', 'test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    coverage: { provider: 'v8', include: ['lib/**', 'app/api/**'] },
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
