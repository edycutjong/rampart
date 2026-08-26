// Flat config. Lints the off-chain classifier in script/ — the half of this project
// that CodeQL can see and that Slither cannot.
//
// Deliberately narrow: the rules below are the ones that catch a WRONG NUMBER or a
// silent failure, not stylistic preference. `forge fmt` is advisory on the Solidity
// side for a hard reason (see CONTRIBUTING.md), and this config keeps the same
// posture on the JS side — correctness enforced, taste not legislated.

import js from '@eslint/js';

export default [
  {
    ignores: ['node_modules/**', 'out/**', 'cache/**', 'lib/**', 'site/**', 'assets/**'],
  },
  js.configs.recommended,
  {
    files: ['script/**/*.mjs', '.github/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        performance: 'readonly',
        // Used by the RPC layer's timeout/retry path.
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      // Async correctness. `require-atomic-updates` catches the read-modify-write
      // race across an await — the shape that makes a network hiccup produce a
      // wrong number rather than an error. (Core ESLint has no floating-promise
      // rule; that one needs typescript-eslint, which this project does not carry.)
      'require-atomic-updates': 'error',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // sequential RPC reads are deliberate here

      // Catch the classic silent-wrong-number bugs.
      'eqeqeq': ['error', 'always'],
      'no-implicit-coercion': ['error', { boolean: false }],
      'no-unsafe-optional-chaining': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'array-callback-return': 'error',

      // Unused vars usually mean a refactor left a value un-threaded.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Bytecode work is full of hex and bit twiddling — keep the guards that matter.
      'no-loss-of-precision': 'error',
      'no-bitwise': 'off',
      'no-plusplus': 'off',
    },
  },
];
