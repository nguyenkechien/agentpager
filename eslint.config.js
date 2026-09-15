import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `apps/desktop/release/` is electron-builder output; a `**/release/` pattern would also skip scripts/release.
  { ignores: ['**/dist/', '**/out/', 'apps/desktop/release/', '**/node_modules/', '**/test-results/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
