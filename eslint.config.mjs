import tseslint from 'typescript-eslint'

// Deliberately minimal — not a general style-linting pass, just the one rule that would have
// caught 0.6.5's crash before it shipped: a Promise-returning call (an Electron API, in that
// case) fired fire-and-forget with no .catch()/.then()/await, which became an unhandled
// rejection and crashed the main process. no-misused-promises catches the sibling mistake
// (passing an async function somewhere a plain callback is expected, e.g. an event handler)
// for the same underlying reason. See ROADMAP.md's Quality section for why this is scoped this
// narrowly rather than adopting a full recommended ruleset.
export default tseslint.config(
  // .d.ts files are ambient type declarations only — no runtime code, so nothing in them can
  // ever be a promise handled or mishandled. Excluded outright rather than pointed at a
  // tsconfig, since src/preload/index.d.ts isn't part of either project's own compiled sources.
  { ignores: ['out/**', 'dist/**', 'build/**', 'node_modules/**', '**/*.d.ts'] },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.node.json', tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error'
    }
  },
  {
    files: ['src/renderer/src/**/*.ts', 'src/renderer/src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.web.json', tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // React doesn't care whether a JSX event handler (onClick={async () => ...}) or a plain
      // callback prop returns a promise — it never awaits either, by design, so flagging every
      // async handler in the whole UI here would just be noise around the idiomatic pattern
      // this codebase already uses throughout (e.g. TopBar's async onClick handlers). Left on
      // for `arguments` (the actual bug shape: passing an async function to something that
      // silently drops the returned promise and was never meant to be async, like
      // Array.prototype.forEach) and `variables`/`returns`, which don't have this false-positive
      // problem.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false, properties: false } }]
    }
  }
)
