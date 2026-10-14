import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'keys/**',
      'jest.config.js',
      'jest.bullmq.config.js',
      'jest.perf.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**', 'src/database/seed-*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Module isolation: only a module's public index may be imported from other modules.
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^[.][.]/(?![.])[^/]+/(?!index$).+',
              message: 'Import other modules only through their public index.',
            },
          ],
        },
      ],
    },
  },
);
