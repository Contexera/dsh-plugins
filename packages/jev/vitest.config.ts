import { defineConfig } from 'vitest/config'

// This package consumes published `@deepseek-ai/cordis` and
// `@deepseek-ai/schemastery`, and every test drives an injected transport, so
// the suite needs no path mapping, no sibling harness checkout and no network.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
