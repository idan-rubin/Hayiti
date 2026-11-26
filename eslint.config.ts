import tseslint from 'typescript-eslint';
export default tseslint.config({
  ignores: ['dist/**', 'node_modules/**']
}, {
  files: ['**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true
    }
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin
  },
  rules: {
    'no-debugger': 'error',
    'no-eval': 'error',
    'no-throw-literal': 'error',
    'no-var': 'error',
    'no-unreachable': 'error',
    'eqeqeq': ['error', 'always', {
      null: 'ignore'
    }],
    '@typescript-eslint/ban-ts-comment': ['error', {
      'ts-expect-error': true
    }],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_'
    }],
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-for-in-array': 'error'
  }
});
