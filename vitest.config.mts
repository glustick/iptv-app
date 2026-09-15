import { defineConfig } from 'vitest/config'

export default defineConfig({
  oxc: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node'
  }
})
