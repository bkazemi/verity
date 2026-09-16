import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '.agents/**', '.codex/**', '.wrangler/**'] },
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { parser: tsParser },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'always', prev: '*', next: 'method' },
            { blankLine: 'always', prev: 'method', next: '*' },
          ],
        },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: '*', next: ['return', 'throw'] },
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try'] },
        { blankLine: 'always', prev: ['if', 'for', 'while', 'switch', 'try'], next: '*' },
        {
          blankLine: 'always',
          prev: '*',
          next: ['function', 'class', 'interface', 'type', 'export'],
        },
        {
          blankLine: 'always',
          prev: ['function', 'class', 'interface', 'type', 'export'],
          next: '*',
        },
        { blankLine: 'always', prev: 'multiline-const', next: '*' },
        { blankLine: 'always', prev: '*', next: 'multiline-const' },
        { blankLine: 'always', prev: 'multiline-expression', next: '*' },
        { blankLine: 'always', prev: '*', next: 'multiline-expression' },
      ],
    },
  },
];
