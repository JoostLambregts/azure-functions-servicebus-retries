# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-19

### Added

- Session ordering: new `preserveSessionOrdering` and `sessionOrderingIncrementMs` options
  ensure messages within a session are retried in sequence-number order
- Integration test suite against a real Service Bus emulator

### Changed

- Expiry handling simplified: the previous three-strategy enum has been replaced with a single
  `preserveExpiresAt` boolean (default: `true`). When `true`, retried messages inherit the
  original TTL; when `false`, the queue default TTL applies
- Build system switched to TSUP (dual CJS + ESM output, no functional change)

[1.0.0]: https://github.com/JoostLambregts/azure-functions-servicebus-retries/compare/v0.1.0...v1.0.0

## [0.1.0] - 2025-02-14

### Added

- Initial public release
- Service Bus queue trigger wrapper with retry functionality
- Configurable backoff strategies: fixed, linear, and exponential
- Jitter support for randomized delays
- Message expiry handling with three strategies: handle, ignore, reject
- TypeScript support with full type definitions
- ESM and CommonJS module formats

### Fixed

- Handle non-standard date format in Service Bus trigger metadata

[0.1.0]: https://github.com/JoostLambregts/azure-functions-servicebus-retries/releases/tag/v0.1.0
