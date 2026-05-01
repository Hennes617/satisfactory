import js from '@eslint/js';
import react from 'eslint-plugin-react';

const globals = {
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  FormData: 'readonly',
  console: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  clearInterval: 'readonly',
  window: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**']
  },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'src/**/*.{js,jsx}', '*.js'],
    plugins: {
      react
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error'
    }
  }
];
