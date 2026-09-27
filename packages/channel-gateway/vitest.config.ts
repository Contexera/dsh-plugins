import { defineConfig } from 'vitest/config'

// The package consumes published `@deepseek-ai/*` npm packages, so tests need
// no path mapping and no sibling Harness checkout: they run in seconds.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
