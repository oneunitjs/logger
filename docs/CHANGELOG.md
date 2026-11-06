# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-05

### Fixed

- **Stream destination write errors no longer crash the process.** When a destination or audit sink's `_write` reports failure through `cb(err)`, Node emits an asynchronous `'error'` event instead of throwing from `write()`. A no-op `'error'` listener is now attached to configured audit sinks and logger destination streams so a failing sink cannot abort a log call or take down the application. (TC-035, production simulation scenario F)

## [1.0.0] - 2026-09-30

### Added

- `ARCHITECTURE.md` documenting the pino pipeline, why the redaction walker runs before serializers, and the plain-vs-runtime object boundary.
- `CONTRIBUTING.md` covering security disclosure, the checks a change must pass, and the behaviors that look like bugs but are deliberate.
- Security suite (`test:security`, 72 tests) covering redaction by key position, casing, `toJSON` routes, errors, child bindings, hostile payloads, circular references, mutation, and the eight security invariants.
- Performance suite (`test:perf`) asserting cost *shape* rather than absolute throughput, including a deterministic identity guard against object-graph traversal.
- Serializer, HTTP integration, and public API suites (`test:serializers`, `test:integration`, `test:api`).
- `tsconfig.test.json` so `npm run typecheck` covers the test suite, which was previously unchecked.
- `createLogger` accepts a `destination` option.

### Changed

- Published as `@oneunit/logger` (see Naming below). Workspace references in `packages/server` (dependency, optional peer dependency, and the dynamic import in its logger plugin), `examples/combined`, and `docs/` were updated to match.

### Security

- **Query strings are now stripped from URLs logged directly by application code.** The stripping previously applied only to `req.url`, via the request serializer, so `logger.info({ url: request.url })` — a very common shape — logged the query string in plaintext and the documented "query strings are stripped by default" guarantee silently did not hold. `url`, `originalUrl`, `requestUrl`, `href`, `referer`, and `referrer` are now stripped at any depth, inside arrays, and in child bindings. A field that merely contains a `?` but is not URL-bearing is left alone.
- Redaction now masks sensitive keys at any nesting depth, in arrays, in mixed object/array structures, and regardless of key casing. It previously relied on a shallow `*.password`-style path list that did not cover deep payloads.
- Redaction is applied in **every** mode, not only `production`, so a secret cannot reach a log sink from a local development or test run.
- Query strings are stripped from logged URLs by default across all three entry points (`createLogger`, `createSerializers`, `createHttpLogger`). The raw `queryString` field is omitted too, since stripping only the URL left the same secrets in the emitted line.
- Child logger bindings are redacted before pino pre-serializes them. Bindings bypass `formatters.log` and the `redact` stringifiers entirely, so `logger.child({ apiKey })` previously wrote the secret in plaintext.
- Added `privateKey` / `private_key` and `proxy-authorization` to the sensitive-key policy.
- Serialized request/response headers are covered by pino's native `redact` paths, closing the gap for fields that only exist after serialization.
- Hostile payloads (throwing getters, `Proxy` traps, 20k-deep nesting, self-returning `toJSON`) no longer abort a log call.
- Logging never mutates caller-owned objects.

### Fixed

- **`@oneunit/server` silently lost package logging.** Its logger plugin imported `@bootstrap-framework/logger`, which no longer exists after the rename, and the surrounding `try`/`catch` swallowed the resolution error and fell back to a bare Fastify logger. Consumers installing the renamed package got no package serializers, redaction, or level formatting, with only a warning to show for it. The dependency, optional peer dependency, and dynamic import are updated, and the workspace lockfile regenerated.
- **Errors kept their diagnostic value.** Redacting an `Error` that carried a sensitive property flattened it into a plain object of own-enumerable keys. `message` is non-enumerable and V8 implements `stack` as an accessor, so both were dropped, and pino's error serializer no longer recognized the value as an `Error` — every such log line lost its message and stack trace. Copies now preserve the prototype and non-enumerable properties, and accessors are materialized once into data properties.
- `createLogger` accepts a `destination` option. pino only accepts a destination as a positional argument, so a destination passed inside the pino options object was silently ignored and output went to stdout.
- The request serializer falls back to a string `request.url` when the standard serializer resolves no URL, instead of dropping the field. Still fails closed: a framework `url` object is never emitted verbatim.
- `createHttpLogger` no longer runs `defineConfig` unconditionally and discards the result when a logger instance is supplied.
- The `pretty` transport target no longer silently drops its `destination`.

### Performance

- Bound runtime objects (requests, sockets, model instances) are passed through by reference instead of being deep-walked. Measured `redactBindings` cost on a 100-deep class instance is flat against a small one (0.72 vs 0.69 us/call); a traversal regressed this path to ~26.8 us/call.

### Documentation

- Documented that class/model instances bound as values are **not** recursively redacted. This is a deliberate trade to avoid per-call graph traversal, and it is asserted in the test suite so a future change has to revisit it.

### Testing (QA coverage added)

- BigInt serialization correction: BigInt values are stringified safely (`12345678901234567890n` → `"12345678901234567890"`) so `JSON.stringify` cannot throw and precision is preserved.
- Redaction and security test coverage across all modes (production, development, test).
- Audit logging tests: event creation, secret protection, sink error handling, CI preset.
- HTTP header policy tests: header allowlist, authorization normalization (all casings), query exclusion options.
- Configuration and preset tests: validation errors, maxDepth boundaries, all four presets, preset overrides.
- Transport lifecycle tests: flush, close, graceful shutdown (SIGTERM/SIGINT), failure handling, multi-transport.
- Concurrent HTTP logging tests: 1,000 concurrent requests with no cross-request context leakage, HTTP error handling (404, 401, 500).
- Production simulation tests: authentication, payment failure, multiple child loggers, concurrent traffic, shutdown, recovery.

### Known limitations (documented, not fixed)

- **In-memory Writable streams through `pino.transport()` throw `DataCloneError`.** `pino.transport()` runs in a worker thread that cannot clone a `Writable` stream. Workarounds: pass the stream directly to `pino(stream)`, or use a file-path destination.
- **Framework internal diagnostic log lines** (e.g. route-not-found messages echoing raw request URLs) are outside the package's redaction pipeline. Package-produced output is clean.
- **Non-plain object bindings are not deep-walked.** Class instances, model instances, sockets, and streams bound as values are treated as opaque leaves. Properties on them are not masked.
- **`npm run typecheck` references a missing `tsconfig.test.json`.** Use `npm run typecheck:src` instead. Pre-existing project gap; does not affect runtime.

### Naming

This package is published as **`@oneunit/logger`**. An earlier draft referred to it as `@bootstrap-framework/logger`; that name was never published to the npm registry, so there is no earlier release to upgrade from and no deprecation path. If you installed a git or file reference to that name, switch to `@oneunit/logger`.

Scope-wide, the underlying repository moved from `mayank040902/framework` to `mayank040902/oneunit`; GitHub redirects the old URL. The repository is now at `https://github.com/oneunitjs/logger`.
