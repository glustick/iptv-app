import { defineConfig } from 'vitest/config'

export default defineConfig({
  oxc: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // macOS resource-fork files (._foo.test.ts) appear on SMB working copies, match the
    // include glob, and are binary garbage to the parser — skip them explicitly.
    exclude: ['**/node_modules/**', '**/._*'],
    environment: 'node'
  }
})
