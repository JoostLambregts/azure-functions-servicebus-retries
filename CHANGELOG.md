# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
