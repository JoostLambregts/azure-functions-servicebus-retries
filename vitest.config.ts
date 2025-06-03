import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/vitest.setup.env.ts'],
    reporters: ['verbose', 'junit'],
    outputFile: {
      junit: './junit.xml'
    },
    coverage: {
      enabled: true,
      all: true,
      exclude: [
        ...configDefaults.coverage.exclude!,
        '*.config.*',
        'types/*',
        '**/main.*'
      ],
      reporter: ['html', 'text', 'text-summary', 'cobertura', 'lcov', 'clover']
    },
    exclude:[
      ...configDefaults.exclude, 
      '**/main.ts'
    ]
  }
})
