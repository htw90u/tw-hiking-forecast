// Lint config for the web app (run: eslint site/js site/sw.js tests/e2e)
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', localStorage: 'readonly',
  fetch: 'readonly', Response: 'readonly', URL: 'readonly', Image: 'readonly', Event: 'readonly', Intl: 'readonly',
  indexedDB: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly', alert: 'readonly',
  DecompressionStream: 'readonly', AbortController: 'readonly', caches: 'readonly', self: 'readonly', L: 'readonly',
  topojson: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly', CustomEvent: 'readonly', performance: 'readonly',
};
const node = { require: 'readonly', process: 'readonly', __dirname: 'readonly', console: 'readonly', URL: 'readonly' };
export default [
  {
    files: ['site/js/**/*.js', 'site/sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browser },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error' },
  },
  {
    files: ['tests/e2e/**/*.cjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...node, document: 'readonly', window: 'readonly', getComputedStyle: 'readonly', localStorage: 'readonly', navigator: 'readonly', fetch: 'readonly', Event: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
];
