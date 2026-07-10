import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // Correctness over style — this config exists to catch real bugs
      // (unused/undefined vars, unreachable code), not to enforce a house
      // style. Do not add stylistic rules (quotes, semi, indent) here.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['src/__tests__/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly', it: 'readonly', expect: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/**', 'uploads/**'],
  },
];
