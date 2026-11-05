# @oneunit/logger

High-performance, secure-by-default structured logging built on [Pino](https://getpino.io). Includes Fastify and HTTP integration, automatic deep redaction, URL sanitization, serializer utilities, and transport builders with lifecycle management.

[![CI](https://github.com/mayank040902/framework/actions/workflows/auth.yml/badge.svg)](https://github.com/mayank040902/framework/actions/workflows/auth.yml)
[![npm](https://img.shields.io/npm/v/@oneunit/auth.svg)](https://www.npmjs.com/package/@oneunit/auth)
[![license](https://img.shields.io/npm/l/@oneunit/auth.svg)](./LICENSE)

---

## What problem does it solve?

Plain Pino logs everything you give it — including passwords, tokens, API keys, cookies, and Authorization headers — either directly in payload fields or transitively through `req.url`, `req.headers`, `res.headers`, `Error` metadata, and child logger bindings. `@oneunit/logger` makes redaction the default so secrets never reach a log sink without explicit opt-out.

Every returned value is a real `pino.Logger` with the full Pino API. The package does not replace Pino; it adds a secure-by-default configuration layer on top.

---

## Main features

| Feature | Description |
|---------|-------------|
| **Pino-powered** | Returns standard `pino.Logger` instances with full Pino API and speed |
| **Deep redaction** | Masks sensitive keys (`password`, `token`, `apiKey`, `authorization`, `cookie`, `sessionid`, etc.) across plain objects and arrays at any nesting depth, with any casing |
| **Active in every mode** | Redaction runs in `production`, `development`, and `test` alike — secrets never leak to local dev terminals or test outputs |
| **URL sanitization** | Strips query strings from URLs (`url`, `originalUrl`, `requestUrl`, `href`, `referer`, `referrer`) at any depth, in arrays, and in bindings |
| **Safe child loggers** | Child bindings are redacted before Pino pre-serializes them, preventing credential leaks in `logger.child({ apiKey })` |
| **Diagnostic integrity** | Preserves `Error.prototype`, non-enumerable `message`, `stack` accessor, `cause` chains, and `AggregateError.errors` |
| **Copy-on-write** | Zero unnecessary allocations on clean log calls; caller payloads are never mutated |
| **Error serialization** | Preserves `Error.cause` chains (cycle-tolerant), `AggregateError.errors`, custom metadata; converts `BigInt` to strings |
| **Fastify & HTTP ready** | Built-in request, response, and error serializers with correlation ID tracking and `pino-http` middleware support |
| **Transport builders** | First-class support for `pretty`, `file`, and `stream` transports with multi-destination dispatch and per-target log levels |
| **Transport lifecycle** | `flush()` and `close()` for graceful shutdown, plus `registerGracefulShutdown()` for SIGTERM/SIGINT process handling |
| **Configuration validation** | `validateConfig()` / `validateConfigOrThrow()` with actionable suggestions for startup verification |
| **Environment presets** | `production()`, `development()`, `test()`, `ci()` with sensible defaults |
| **Subpath exports** | Modular entry points: `/logger`, `/config`, `/http`, `/serialize`, `/transport`, `/presets`, `/config-validation` |

---

## Architecture overview

The logging pipeline runs in a strict order:

```text
logger.info(payload)
    │
    ▼
formatters.log  →  redactLogObject (recursive walker)    [Runs FIRST]
    │
    ▼
pino serializers → createSerializers (req / res / err)   [Runs SECOND]
    │
    ▼
redact.paths   →  fast-redact stringifiers                [Runs LAST]
    │
    ▼
JSON.stringify → destination stream
```

1. **The walker runs first** and sees framework-parsed `query` objects before serializers copy them.
2. **The walker preserves `Error` identity** (prototype, non-enumerable `message`, `stack` accessor) so pino's error serializer still recognizes the object.
3. **`redact.paths` covers post-serialization headers** (`res.headers`, etc.) that the walker cannot see.

See `ARCHITECTURE.md` for the full technical architecture, design decisions, and limitations.

---

## Supported versions

- **Node.js:** `20` to latest (all actively supported LTS and current releases)
- **TypeScript:** `^5.9.x`
- **Pino:** `^10.4.0` (runtime dependency)
- **pino-http:** `^11.0.0` (runtime dependency)
- **pino-std-serializers:** `^7.1.0` (runtime dependency)
- **pino-pretty:** `^13.1.3` (optional peer, for pretty transport)
- **Fastify:** `^5.12.5` (for documented integration, dev dependency)

---

## Install

```bash
npm install @oneunit/logger
```

### Optional pretty printing

`pino-pretty` is an optional peer dependency. Install it for colored, formatted output in development:

```bash
npm install -D pino-pretty
```

---

## Quick start

```typescript
import { createLogger } from "@oneunit/logger";

const logger = createLogger({ mode: "development" });

logger.info("Service initialized");
logger.warn({ latencyMs: 340 }, "Database query took longer than threshold");
logger.error(new Error("Connection reset"), "Upstream service failure");

// Child loggers inherit parent configuration and redact bindings automatically
const child = logger.child({ requestId: "req-123", apiKey: "secret_live_key" });
child.info("Handling request");
// -> { "requestId": "req-123", "apiKey": "[REDACTED]", "msg": "Handling request" }
```

---

## Basic logger creation

```typescript
import { createLogger } from "@oneunit/logger";

const logger = createLogger({
    mode: "production",        // "development" | "production" | "test" (default: "production")
    destination: process.stdout, // optional; defaults to stdout
    context: {
        service: "payment-service",
        env: "production",
        version: "1.0.0",
    },
});

logger.info("Application started");
logger.warn("Warning message");
logger.error("Error message");
```

### The `destination` option

Pino only accepts a destination as a separate positional argument, so `@oneunit/logger` exposes `destination` as a top-level option. Passing `{ destination }` inside a nested Pino options object is silently ignored by Pino, which can result in lost output.

```typescript
// Correct:
const logger = createLogger({ mode: "production", destination: myStream });

// Incorrect — destination is silently ignored:
const logger = createLogger({ mode: "production", pino: { destination: myStream } });
```

---

## Environment-specific configuration

### `defineConfig`

Generates Pino options for a given mode:

```typescript
import { defineConfig } from "@oneunit/logger/config";

const config = defineConfig({ mode: "production" });
// { level: "info", base: { pid, hostname, ...context }, formatters: { log, level },
//   timestamp: isoTime, redact: { paths, censor, remove: false } }
```

| Mode | Level | Redaction |
|------|-------|-----------|
| `development` | `trace` | Active |
| `production` | `info` | Active (default) |
| `test` | `silent` | Active |

Redaction is applied in **every** mode. A secret must not reach a terminal or CI log just because the run is local.

---

## Log levels and usage examples

All standard Pino levels are available: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

```typescript
logger.trace("verbose diagnostic");
logger.debug("debug detail");
logger.info("Application started");
logger.warn("Warning message");
logger.error("Error message");
logger.fatal("Fatal error");

// With structured data
logger.info({ userId: "USER-001", latencyMs: 42 }, "Request processed");

// With an Error
logger.error(new Error("Connection reset"), "Database query failed");

// Positional error (first argument)
logger.error(new Error("boom"), "Something failed");
```

Child logger:

```typescript
const child = logger.child({ module: "payments", requestId: "req-123" });
child.info("Processing payment");
```

---

## Redaction configuration

### Default sensitive keys

Matched case-insensitively at any nesting depth, replaced with `"[REDACTED]"` (or custom `replacement`):

- **Passwords:** `password`, `passwordhash`, `password_hash`, `passwd`, `pwd`
- **Tokens:** `token`, `accesstoken`, `refreshtoken`, `idtoken`, `sessiontoken`, `sessionid`
- **Secrets:** `secret`, `clientsecret`, `client_secret`
- **Keys:** `privatekey`, `private_key`, `apikey`, `api_key`
- **Auth & cookies:** `authorization`, `proxy-authorization`, `cookie`, `set-cookie`

### Basic redaction

```typescript
const logger = createLogger({
    mode: "production",
    redaction: {
        keys: ["sessionToken", "internalId"], // additional sensitive keys
        replacement: "[MASKED]",              // custom mask string
        maxDepth: 50,                         // recursion limit (default 100)
    },
});

logger.info({
    username: "alice",
    password: "s3cret",
    nested: { apiKey: "key-123" },
    items: [{ token: "tok-abc" }],
});
// All sensitive fields are masked; unrelated fields pass through.
```

### Custom redaction rules

Rules match by key name (case-insensitive) or path regex (tested against dot-joined key path):

```typescript
const logger = createLogger({
    redaction: {
        rules: [
            {
                keys: ["apiKey"],
                mask: "[API_KEY_HIDDEN]",
            },
            {
                path: /\.token$/,
                mask: "[TOKEN_REDACTED]",
            },
            {
                keys: ["apiKey"],
                handler: (value, key, context) =>
                    `hash(${String(value).length})`,
            },
        ],
    },
});
```

| Rule field | Type | Description |
|------------|------|-------------|
| `keys` | `string[]` | Key names to match (case-insensitive) |
| `path` | `RegExp` | Path pattern tested against dot-joined key path |
| `handler` | `(value, key, context) => unknown` | Transform value before masking |
| `mask` | `string` | Override replacement string |

Handler context includes `path` (string array), `depth`, and `isBinding`. If a handler throws, the configured mask is used — the original secret is never emitted.

### Header allowlist and authorization normalization

```typescript
const logger = createLogger({
    redaction: {
        headerAllowlist: ["content-type", "user-agent"], // only these pass through
        normalizeAuth: true,                              // always redact Authorization
    },
});
```

- `normalizeAuth: true` rewrites `Authorization` (any casing) to `[REDACTED]`.
- `headerAllowlist` passes only listed headers (case-insensitive); all others are redacted.
- These options also apply to HTTP serializers via `createSerializers` and `createHttpLogger`.

---

## Custom redaction rules: complete example

```typescript
import { createLogger } from "@oneunit/logger";

const logger = createLogger({
    redaction: {
        keys: ["sessionToken", "internalId"],
        rules: [
            { keys: ["apiKey"], mask: "[KEY_MASKED]" },
            { path: /\.secret$/, handler: (v) => `hash(${String(v).length})` },
        ],
        maxDepth: 50,
        headerAllowlist: ["content-type", "user-agent"],
        normalizeAuth: true,
        audit: {
            enabled: true,
            sink: process.stderr,
            eventLevel: "warn",
        },
    },
});
```

---

## Child logger usage and safe bindings

Child bindings are redacted before Pino pre-serializes them:

```typescript
const child = logger.child({
    requestId: "req-123",
    apiKey: "secret_live_key", // -> "[REDACTED]" in output
});
child.info("Handling request");
```

This works for `logger.child()`, `createChildLogger()`, and `withContext()`:

```typescript
import { createChildLogger, withContext } from "@oneunit/logger";

const child = createChildLogger(logger, { password: "s3cret" });
// password is redacted

const requestLogger = withContext(logger, {
    requestId: "req-123",
    sessionToken: "s3cret-token", // -> "[REDACTED]"
});
requestLogger.info("With context");
```

The original logger is unchanged by `withContext`.

### Important limitation

Non-plain objects (class instances, model instances, sockets, streams) bound as values are treated as opaque leaves and **not** deep-walked:

```typescript
class UserModel {
    password = "MODEL_SECRET";
}

logger.child({ user: new UserModel() });
// user.password is NOT masked — the instance is passed by reference
```

Bind plain objects instead, or redact sensitive fields at the call site.

---

## HTTP logging and serializers

### `createSerializers`

Builds `req`, `res`, and `err` serializers with sanitization:

```typescript
import { createSerializers } from "@oneunit/logger/serialize";

const serializers = createSerializers({
    excludeQueryString: true,   // default: strip query from url
    excludeHeaders: false,      // keep headers, redact sensitive ones
    excludeQuery: false,        // keep parsed query, mask sensitive keys
    headerAllowlist: ["content-type", "user-agent"],
    normalizeAuth: true,        // always redact Authorization
});
```

Serialized request fields: `id`, `method`, `url` (sanitized), `host`, `hostname`, `correlationId` (from `x-correlation-id`), `remoteAddress`, `remotePort`, `protocol`, `headers` (processed), `query` (masked), `queryString` (omitted by default).

Serialized response fields: `statusCode` (omitted if null/uncommitted), `headers` (processed).

Serialized error fields: `type`, `message`, `stack`, `cause` (recursive, cycle-safe), `errors` (AggregateError), own enumerable properties.

### `createHttpLogger` (pino-http middleware)

```typescript
import { createLogger, createHttpLogger } from "@oneunit/logger";

const logger = createLogger({ mode: "production" });
const httpLogger = createHttpLogger({ logger });

// Use as Express middleware:
app.use(httpLogger);

// Or with raw Node http:
const server = http.createServer((req, res) => {
    httpLogger(req, res);
    res.end("ok");
});
```

`createHttpLogger` wraps `pino-http` and substitutes the package's serializers for the standard request/response/error serializers. By default the query string is stripped from the logged URL and the raw `queryString` field is omitted.

### Error logging examples

```typescript
// Standard error
logger.error(new Error("Payment failed"), "payment error");

// Error with cause
const original = new Error("Database unavailable");
const error = new Error("Payment failed", { cause: original });
logger.error({ err: error }, "payment failure");

// Error with custom metadata (sensitive values are redacted)
Object.assign(error, { transactionId: "TX-001", password: "SECRET" });
logger.error({ err: error }, "payment failure");
// -> err.type: "Error", err.message: "Payment failed", err.transactionId: "TX-001",
//    err.password: "[REDACTED]", err.cause preserved

// AggregateError
const agg = new AggregateError(
    [new Error("Database failed"), new Error("Network failed")],
    "Multiple failures"
);
logger.error({ err: agg }, "aggregate failure");
```

---

## Audit logging examples

Audit events are emitted to a separate sink and never contain the original secret:

```typescript
import { Writable } from "node:stream";
import { createLogger } from "@oneunit/logger";

const auditEvents: unknown[] = [];
const auditSink = new Writable({
    write(chunk, _enc, cb) {
        const text = chunk.toString().trim();
        if (text) auditEvents.push(JSON.parse(text));
        cb();
    },
});

const logger = createLogger({
    mode: "production",
    redaction: {
        audit: {
            enabled: true,
            sink: auditSink,
            eventLevel: "warn",
        },
    },
});

logger.info({ password: "SECRET" }, "audited");
// Audit sink receives: { event: "redaction", key: "password", path: ["password"], ... }
// No secret value in the event
```

---

## Presets and configuration options

### Environment presets

```typescript
import { createLoggerFromPreset, presets } from "@oneunit/logger";

const logger = await createLoggerFromPreset("production", {
    service: "payment-service",
    version: "1.2.0",
});
```

| Preset | Level | Key behaviors |
|--------|-------|---------------|
| `presets.production()` | `info` | Header allowlisting (`content-type`, `content-length`, `user-agent`), auth normalization |
| `presets.development()` | `trace` | Verbose local output, full redaction active |
| `presets.test()` | `silent` | Minimal silent output, full redaction active |
| `presets.ci()` | `silent` | Audit enabled (`warn`), strict header allowlisting (`content-type`) |

Presets are convenience defaults, not restrictions — all Pino options remain overridable.

### `createLogger` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `"development" \| "production" \| "test"` | `"production"` | Log level and environment settings |
| `context` | `LogContext` | `undefined` | Standardized context metadata on every line |
| `destination` | `WritableStream` | `process.stdout` | Destination stream or transport worker |
| `childBindings` | `Record<string, unknown>` | `undefined` | Initial bindings (automatically redacted) |
| `serializers` | `SerializerOptions` | `undefined` | HTTP serializer options |
| `redaction` | `RedactionConfig` | `undefined` | Redaction engine configuration |
| `pino` | `pino.LoggerOptions` | `undefined` | Escape hatch for remaining Pino options |

### `LogContext` fields

`service`, `env`, `version`, `tenantId`, `correlationId`, `requestId`, plus arbitrary keys.

---

## Transport configuration

### Pretty transport

```typescript
import pino from "pino";
import { createLogger, createTransport } from "@oneunit/logger";

const transport = pino.transport(createTransport({
    target: "pretty",
    level: "debug",
    destination: "/var/log/app.log", // or a Writable stream
}));

const logger = createLogger({ destination: transport });
```

`pino-pretty` is required (optional peer dependency).

### File transport

```typescript
const transport = pino.transport(createTransport({
    target: "file",
    destination: "/var/log/app.log",
}));

const logger = createLogger({ destination: transport });
```

### Stream transport

```typescript
const transport = pino.transport(createTransport({
    target: "stream",
    destination: myWritableStream,
}));

// Note: pino.transport() runs in a worker thread and cannot clone an
// in-memory Writable stream. Use pino(stream) directly for in-memory streams,
// or use a file-path destination.
```

### Multi-destination logging

```typescript
import pino from "pino";
import { createLogger, createMultiTransport } from "@oneunit/logger";

const multi = pino.transport(createMultiTransport([
    { target: "pretty", level: "info" },
    { target: "file", destination: "/var/log/app/debug.log", level: "debug" },
]));

const logger = createLogger({ destination: multi });
```

---

## Flush and graceful shutdown

```typescript
import { createTransportInstance, registerGracefulShutdown } from "@oneunit/logger";

const transport = createTransportInstance({
    target: "file",
    destination: "/var/log/app.log",
});

const logger = createLogger({
    mode: "production",
    destination: transport,
});

// Automatic shutdown on SIGTERM / SIGINT
const cleanup = registerGracefulShutdown(transport, { exitCode: 0 });

// Manual shutdown
await transport.flush();
await transport.close();

// Unregister signal handlers
cleanup();
```

`flush()` waits for pending writes to drain. `close()` releases transport resources. If the underlying transport does not support these operations, the methods resolve immediately.

---

## Fastify 5 integration

### Correct integration: `loggerInstance`

Pass the logger as `loggerInstance`, **not** `logger`:

```typescript
import Fastify from "fastify";
import { createLogger } from "@oneunit/logger";

const logger = createLogger({ mode: "production" });

const app = Fastify({
    loggerInstance: logger,
});

app.get("/users", async (request) => {
    request.log.info({ query: request.query }, "Fetched users");
    return { status: "ok" };
});

await app.listen({ port: 3000 });
```

The package's serializers, redaction, level formatting, and destination are all used.

### Incorrect integration: `logger` (anti-pattern)

```typescript
// DO NOT USE — Fastify builds its own logger
const app = Fastify({ logger: createLogger({ mode: "production" }) });
```

In Fastify 5, `logger` accepts `boolean | options`. Handing it a logger instance makes Fastify build its **own** Pino logger. Nothing throws — the server starts and serves — but the package's serializers, redaction, and level formatting are all absent, and output goes to stdout instead of the configured destination.

### Express integration

```typescript
import express from "express";
import { createLogger, createHttpLogger } from "@oneunit/logger";

const logger = createLogger({ mode: "production" });
const httpLogger = createHttpLogger({ logger });

const app = express();
app.use(httpLogger);

app.get("/hello", (req, res) => {
    req.log.info({ password: "s3cret" }, "handling hello"); // password is redacted
    res.json({ message: "hello" });
});
```

---

## Testing and development commands

| Script | Description |
|--------|-------------|
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm run dev` | Watches and compiles TypeScript |
| `npm run typecheck` | Type-checks source (`tsconfig.json` and `tsconfig.test.json`) |
| `npm run typecheck:src` | Type-checks source code only |
| `npm test` | Runs the complete Vitest test suite |
| `npm run test:watch` | Runs Vitest in watch mode |
| `npm run test:security` | Runs security suite |
| `npm run test:integration` | Runs Fastify and `pino-http` integration tests |
| `npm run test:serializers` | Runs serializer tests |
| `npm run test:api` | Verifies public API surface |
| `npm run test:perf` | Runs performance regression tests |
| `npm run pack:check` | Verifies published package contents (dry run) |
| `npm run verify` | Full CI verification (build, typecheck, examples, test, pack check) |

---

## Production deployment recommendations

1. **Use `presets.production()` or `presets.ci()`** for sensible defaults, then override as needed.
2. **Use file-path destinations** with `pino.transport()` for `file` and `stream` targets (in-memory Writable streams cannot be cloned across the worker thread boundary).
3. **Register graceful shutdown** with `registerGracefulShutdown()` to flush pending logs on SIGTERM/SIGINT.
4. **Validate configuration at startup** with `validateConfigOrThrow()`.
5. **Never pass real production credentials in tests** — use synthetic test data with unique markers.
6. **Use `loggerInstance`** (not `logger`) for Fastify 5 integration.
7. **Audit mode** is recommended for CI/CD environments to gain visibility into redaction events without exposing secrets.

---

## Troubleshooting and common mistakes

| Problem | Likely cause | Fix |
|---------|--------------|-----|
| No log output | `destination` passed inside `pino` options | Use top-level `destination` option |
| Secrets in output | Using Fastify `logger` instead of `loggerInstance` | Switch to `loggerInstance` |
| `DataCloneError` on stream transport | `pino.transport()` can't clone Writable streams | Use `pino(stream)` directly or a file path |
| Pretty transport missing | `pino-pretty` not installed | `npm install -D pino-pretty` |
| Config validation errors | Invalid `mode`, `maxDepth`, keys, or rules | Check `validateConfig` error messages and suggestions |
| Child bindings not redacted | Using `pino.child()` directly instead of wrapped logger | Use `createLogger` instance (safe-child wrapping is automatic) |

---

## Known limitations

1. **Non-plain object bindings are not deep-walked.** Class instances, model instances, sockets, and streams bound as values are treated as opaque leaves. Properties on them are not masked. Bind plain objects or redact at call site.
2. **In-memory Writable streams through `pino.transport()` throw `DataCloneError`.** Use `pino(stream)` directly or a file-path destination.
3. **Fastify internal diagnostic log lines** (e.g. route-not-found messages with raw URLs) are outside the package's redaction pipeline. Package-produced output is clean.
4. **`maxDepth` default is 100.** Objects nested deeper are not traversed beyond the boundary to prevent stack overflow.

---

## API reference

All 21 functions are accessible from the root entry point `@oneunit/logger`:

| Function | Description |
|----------|-------------|
| `createLogger(options?)` | Creates a Pino logger with redaction and safe child wrapping |
| `createChildLogger(logger, bindings?)` | Safely creates a child logger |
| `withContext(logger, context)` | Returns an immutable child logger with merged context |
| `createHttpLogger(options?)` | `pino-http` middleware with pre-configured serializers |
| `createSerializers(options?)` | Request, response, and error serializers |
| `defineConfig(options?)` | Generates Pino configuration options |
| `redactLogObject(object)` | Masks sensitive keys without mutating input |
| `redactBindings(bindings)` | Masks sensitive keys in child bindings |
| `resolveRedactionConfig(config?)` | Resolves partial redaction config |
| `createRedactionEngine(resolved)` | Instantiates a low-level redaction engine |
| `createRedactFormatter(sensitiveKeys)` | Creates a `formatters.log` function |
| `createTransport(options?)` | Builds a Pino transport target definition |
| `createMultiTransport(transports)` | Builds multi-target transport definition |
| `createTransportInstance(options?)` | Transport wrapper with `flush()` and `close()` |
| `createMultiTransportInstance(transports)` | Multi-destination transport with lifecycle |
| `registerGracefulShutdown(transport, options?)` | SIGTERM/SIGINT handlers for graceful shutdown |
| `validateConfig(options)` | Validates config, returns errors without throwing |
| `validateConfigOrThrow(options)` | Validates config, throws on error |
| `presets` | Environment preset factories |
| `resolvePreset(name, options?)` | Resolves and validates preset configuration |
| `createLoggerFromPreset(name, options?)` | Creates a logger from a preset |

Re-exported Pino types: `Logger`, `Level`, `LevelWithSilent`, `DestinationStream`.

See `ARCHITECTURE.md` for detailed internal architecture and `CHANGELOG.md` for release history.

---

## Subpath exports

| Subpath | Source | Exports |
|---------|--------|---------|
| `@oneunit/logger` | `src/index.ts` | Complete public API + Pino types |
| `@oneunit/logger/logger` | `src/logger/logger.ts` | `createLogger`, `createChildLogger`, `withContext` |
| `@oneunit/logger/config` | `src/logger/config.ts` | `defineConfig`, `redactLogObject`, `redactBindings`, `createRedactFormatter`, `createRedactionEngine`, `resolveRedactionConfig`, `processHeaders` |
| `@oneunit/logger/config-validation` | `src/config-validation.ts` | `validateConfig`, `validateConfigOrThrow` |
| `@oneunit/logger/http` | `src/http/middleware.ts` | `createHttpLogger` |
| `@oneunit/logger/serialize` | `src/http/serializers.ts` | `createSerializers` |
| `@oneunit/logger/presets` | `src/presets.ts` | `presets`, `resolvePreset`, `createLoggerFromPreset` |
| `@oneunit/logger/transport` | `src/transport/transport.ts` | `createTransport`, `createMultiTransport` |

---

## Contribution guidelines

1. Fork the repository and create a feature branch.
2. Make changes to source code and tests.
3. Run `npm run verify` (build, typecheck, tests, pack check).
4. Ensure all security-critical tests pass — no secret may appear in any emitted log line.
5. Update `CHANGELOG.md` using Keep a Changelog conventions.
6. Submit a pull request.

---

## License

MIT © 2026 mayank
