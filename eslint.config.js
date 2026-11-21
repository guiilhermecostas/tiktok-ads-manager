import js from '@eslint/js';
import globals from 'globals';

/** Regras comuns: erros reais e hábitos que evitam bugs. */
const common = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-shadow': 'error',
  eqeqeq: 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  'no-throw-literal': 'error',
  'no-param-reassign': ['error', { props: false }],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
};

export default [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    // Servidor, regras compartilhadas e testes (Node).
    files: ['src/**/*.js', 'shared/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.node } },
    rules: common,
  },
  {
    // Front-end (navegador): proíbe APIs que interpretam HTML (defesa contra XSS).
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      ...common,
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use nós de texto (XSS).' },
        { property: 'outerHTML', message: 'Use nós de texto (XSS).' },
        { property: 'insertAdjacentHTML', message: 'Use nós de texto (XSS).' },
      ],
    },
  },
];
