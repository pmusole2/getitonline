module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    es2022: true,
  },
  overrides: [
    {
      // This file is CommonJS; the app source is ES modules.
      files: ['*.cjs'],
      env: { node: true },
      parserOptions: { sourceType: 'script' },
    },
  ],
  // Formatting belongs to Prettier (apps/mobile/.prettierrc.json), so no formatting rules are enabled here.
  // `curly` is not set: the mobile screens use brace-less single-line `if` bodies throughout.
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'react-hooks/rules-of-hooks': 'error',
  },
};
