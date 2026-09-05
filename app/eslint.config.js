import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

const noReact = {
  paths: [{ name: 'react', message: 'Services, infra, stores and domains must not import React.' }],
};
const noTauri = {
  patterns: [{ group: ['@tauri-apps/*'], message: 'Use an infra adapter for native capabilities.' }],
};

export default [
  { ignores: ['dist/**', 'src-tauri/**', 'public/**', 'scripts/**', 'node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint, 'react-hooks': reactHooks },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs['recommended-latest'].rules,
      // TS 编译器负责全局/类型检查（DOM/WebAudio 类型来自 lib.dom）；no-undef 只对 JS 层生效。
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // UI layer: React allowed, native capabilities only via infra.
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/shell/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', noTauri] },
  },
  // Services / stores / domains: no React, no direct Tauri imports.
  {
    files: ['src/services/**/*.ts', 'src/stores/**/*.ts', 'src/domains/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { ...noReact, ...noTauri }],
    },
  },
  // Infra: the only layer allowed to touch @tauri-apps/*; still no React.
  {
    files: ['src/infra/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', noReact] },
  },
];
