import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['tests/**/*.test.tsx', 'src/**/*.test.tsx'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
});
