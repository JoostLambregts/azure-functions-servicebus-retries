import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['./test/integration/vitest.setup.integration.ts'],
    testTimeout: 60_000,
    reporters: ['verbose'],
    fileParallelism: false,
  }
})
