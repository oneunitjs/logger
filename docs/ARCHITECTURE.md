# Architecture — `@oneunit/logger`

`@oneunit/logger` is a thin, opinionated security layer over [Pino](https://getpino.io). It does not replace Pino: every returned value is a real `pino.Logger` with the full Pino surface, and `pino` remains a peer-visible dependency rather than being hidden. What the package adds is secure-by-default configuration, HTTP serializers that do not leak, and a deep redaction pass that runs before Pino's own serializers.

Three runtime dependencies: `pino`, `pino-http`, and `pino-std-serializers`. `pino-pretty` is an optional peer dependency, loaded only by the pretty transport.

---

## 1. Project Overview and Goals

**What:** A structured logging library for Node.js 20+ that wraps Pino with automatic deep redaction, HTTP request/response serializers, error serialization, transport builders, and lifecycle management.

**Why:** Plain Pino does not redact sensitive data by default. Application developers routinely log passwords, tokens, API keys, cookies, and Authorization headers — either directly in payload fields or transitively through `req.url`, `req.headers`, `res.headers`, `Error` metadata, and child logger bindings. `@oneunit/logger` makes redaction the default so secrets never reach a log sink without explicit opt-out.

**Who:** Application developers who consume `@oneunit/logger` as a dependency; platform engineers who configure transports, presets, and graceful shutdown; security reviewers who audit that no secret escapes any logging path.

**Design principles:**

- **Secure by default.** Redaction runs in every mode (`development`, `production`, `test`). Sensitive keys (`password`, `token`, `apiKey`, `authorization`, `cookie`, etc.) are masked case-insensitively at any nesting depth, inside arrays, and in child bindings.
- **Never mutate caller-owned data.** The redaction walker is copy-on-write: it returns the original reference when nothing matched and clones only along paths that actually changed.
- **Preserve diagnostic value.** `Error` objects keep their `message`, `stack`, `cause` chains, `AggregateError.errors`, and `instanceof Error` identity even while sensitive attached properties are redacted.
- **Pino is the engine, not a black box.** Returned instances are real Pino loggers; consumers can use the full Pino API (`child`, `isLevelEnabled`, `flush`, serializers, formatters, etc.).
- **Fail safe, not silently.** Hostile payloads (throwing getters, `Proxy` traps, circular references, extreme nesting) must not crash a log call or silently fall back to emitting unredacted data. Stream write failures are swallowed so a failing destination cannot take down the process.

---

## 2. Architecture Principles and Design Decisions

### Pipeline order is load-bearing

The single most important architectural property is the order of operations in Pino's logging pipeline:

```text
caller calls logger.info(payload)
        |
        v
pino merges base, level, timestamp
        |
        v
formatters.log  ->  redactLogObject (our walker)     [Runs FIRST]
        |
        v
pino serializers -> createSerializers (req / res / err)  [Runs SECOND]
        |
        v
redact.paths   ->  fast-redact stringifiers              [Runs LAST]
        |
        v
JSON.stringify -> destination stream
```

Three consequences follow, and each one is load-bearing:

1. **The walker sees parsed query before the serializer copies it.** The walker masks sensitive keys in query-like objects before `createSerializers` moves that object into the emitted line. A raw `IncomingMessage` has no `query` property at all, and `pino-std-serializers` v7 does not parse one out of the URL, so nothing is emitted for it. Neither path can leak a query secret.

2. **The walker runs before the `err` serializer, so it must not destroy the `Error`.** An earlier version copied only own enumerable keys. `message` is non-enumerable and V8 implements `stack` as an own accessor over internal `[[ErrorData]]`, so both were dropped; the flattened value then failed the std serializer's `instanceof Error` check and the line lost its message and stack entirely. `safeShallowCopyPreserving` keeps the prototype and non-enumerable properties and materializes accessors into data properties.

3. **The walker cannot see fields that only exist after serialization**, most notably `res.headers`. Those are covered by Pino's own `redact.paths`, which is why `DEFAULT_REDACT_PATHS` exists. The walker and the path list are complementary, not redundant.

### Plain data is walked; runtime objects are not

`redactDeep` distinguishes plain objects and arrays (prototype is `Object.prototype` or `null`) from everything else. Plain data is traversed to any depth, up to `maxDepth` (default 100, configurable). Non-plain objects — class instances, streams, `IncomingMessage`, sockets, model objects — are treated as opaque leaves and passed by reference.

This is a deliberate trade, not an oversight. Bindings routinely hold live objects whose graph runs `socket -> connection -> parser -> ...`; deep-walking one on every log call cost roughly 26.8 µs/call against roughly 0.7 µs/call for the non-walking path. The limitation is real and user-visible: a `password` on a bound `UserModel` is not masked. Application developers must not assume secrets inside arbitrary model instances are automatically masked.

### Copy-on-write, never mutate

The walker returns the original object untouched when nothing matched, and clones only along paths that actually changed. Two things follow: the common no-match path allocates nothing (measured 1.55 µs/call for `redactLogObject` against 3.5 µs/call for the whole logging path), and caller-owned data is never mutated.

### URL keys have their query string stripped

The walker rewrites string values under `url`, `originalUrl`, `requestUrl`, `href`, `referer`, and `referrer` to remove the query portion. The request serializer already strips `req.url`, but a serializer only sees the key it was registered for. An application log of the form `logger.info({ url: request.url })` never reaches it, so without this the documented default would have held for `req` and failed for the most common shape of all. Stripping at the walker covers both, at any depth, in arrays, and in bindings.

The rewrite is reference-preserving when there is no query, so the no-match path still allocates nothing. A field that contains a `?` but is not URL-bearing is left untouched, which is why the key set is explicit rather than pattern-based.

### Child bindings are a separate path

Pino serializes child bindings into a pre-built JSON string at child-creation time (`asChildings`). They therefore reach neither `formatters.log` nor the `redact` stringifiers, and `logger.child({ apiKey })` would write the secret in plaintext. They are masked in `redactBindings` *before* `child()` is called.

Redacting in `createChildLogger` alone would not be enough, because `logger.child(...)` is itself a documented way to create a child. So `installSafeChild` wraps the `child` method on the root instance; Pino builds children with `Object.create(this)`, so the wrapper is inherited by the whole tree and captures the prototype's original `child` to preserve inherited bindings. The installation is marked with a well-known symbol (`Symbol.for("@oneunit/logger.safeChild")`) to prevent redundant wrapping.

Pino does offer a `formatters.bindings` hook, but it cannot be used here: `proto.js` rebuilds a child's formatters through `resetChildingsFormatter` and drops it.

### Custom sensitive keys and redaction rules

`LoggerOptions.redaction` accepts a `RedactionConfig` with custom keys, named rules, a custom max depth, audit mode, header allowlisting, and authorization normalization:

```typescript
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

- **`keys`**: additional case-insensitive sensitive keys merged with defaults.
- **`rules`**: named rules matched by key name (case-insensitive) or path regex (tested against dot-joined key path). Rules can supply a custom `handler` that transforms the value before masking, and an override `mask`.
- **`maxDepth`**: recursion limit for the walker (default 100, between 1 and 10000).
- **`headerAllowlist`**: when set, only listed header names pass through; all others are redacted.
- **`normalizeAuth`**: when true, `Authorization` headers are always redacted.
- **`BigInt` safety**: `BigInt` primitives encountered during redaction are converted to strings (`String(value)`) so downstream JSON serialization cannot throw.
- **`audit`**: when enabled, each redaction event is emitted to a separate audit sink. The secret value is never included.

Custom keys apply at any nesting depth, inside arrays, with any casing, and in child bindings — across all modes (`development`, `production`, `test`).

### Audit mode

When `redaction.audit.enabled` is true, each redaction event is emitted to a separate audit sink as:

```json
{
  "event": "redaction",
  "key": "password",
  "path": ["user", "account", "credentials", "password"],
  "depth": 3,
  "isBinding": false,
  "timestamp": "2026-11-05T10:30:00.000Z",
  "level": "warn"
}
```

The secret value is never included in the audit event. Audit sink write failures are swallowed so a failing sink cannot abort the log call.

---

## 3. High-Level Architecture and Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Application Code                              │
│  createLogger({ mode, destination, redaction, context, ... })       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Logger Factory (createLogger)                   │
│  • defineConfig() → Pino options (level, base, formatters, redact)  │
│  • createSerializers() → req / res / err serializers                │
│  • installSafeChild() → wraps logger.child() for binding redaction  │
│  • pino(options, destination) → real Pino Logger instance           │
└─────────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
│  Context / base  │  │   Serializers│  │   Redaction      │
│  (pid, hostname, │  │  req / res   │  │  walker runs     │
│   service, env,  │  │  / err       │  │  BEFORE serializers│
│   version...)    │  │              │  │  in formatters.log │
└──────────────────┘  └──────────────┘  └──────────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Pino Logging Pipeline                            │
│                                                                       │
│  1. formatters.log  → redactLogObject (recursive walker)            │
│     - Masks sensitive keys, URL query strings, BigInt → string      │
│     - Preserves Error prototype, non-enums, accessors               │
│     - Copy-on-write; caller data never mutated                      │
│                                                                       │
│  2. Pino serializers → createSerializers (req / res / err)          │
│     - Strips query string from url, processes headers,              │
│     - Serializes cause chains, AggregateError, custom metadata      │
│                                                                       │
│  3. redact.paths  → fast-redact stringifiers                        │
│     - Covers post-serialization headers (res.headers, etc.)         │
│                                                                       │
│  4. JSON.stringify → destination                                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────┐                  ┌──────────────────┐
│  File transport  │                  │  Stream transport│
│  (pino/file)     │                  │  (direct stream) │
└──────────────────┘                  └──────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Transport Lifecycle (flush / close / shutdown)         │
│  createTransportInstance / createMultiTransportInstance             │
│  registerGracefulShutdown (SIGTERM / SIGINT → flush → close → exit) │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Internal Package Structure and Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| Public entry point | `src/index.ts` | Re-exports every module plus Pino type aliases (`Logger`, `Level`, `DestinationStream`) |
| Types | `src/types.ts` | All type definitions (`LoggerOptions`, `RedactionConfig`, `SerializerOptions`, `TransportOptions`, etc.) |
| Config validation | `src/config-validation.ts` | `validateConfig()` / `validateConfigOrThrow()` — descriptive errors without throwing (or throwing) |
| Presets | `src/presets.ts` | Environment presets (`production`, `development`, `test`, `ci`), `resolvePreset()`, `createLoggerFromPreset()` |
| Logger config | `src/logger/config.ts` | Redaction engine: `resolveRedactionConfig`, `createRedactionEngine`, `redactDeep` walker, `formatters.log`, `redactLogObject`, `redactBindings`, `processHeaders`, URL stripping, BigInt safety, audit emission |
| Logger factory | `src/logger/logger.ts` | `createLogger`, `createChildLogger`, `withContext`, `installSafeChild` (wraps `logger.child()` for binding redaction) |
| HTTP serializers | `src/http/serializers.ts` | `createSerializers()` — `req`, `res`, `err` serializers with URL/query/header sanitization |
| HTTP middleware | `src/http/middleware.ts` | `createHttpLogger()` — `pino-http` wrapper wired to custom serializers |
| Transport definition | `src/transport/transport.ts` | `createTransport()`, `createMultiTransport()` — target definitions for `pretty`, `file`, `stream` |
| Transport lifecycle | `src/transport/lifecycle.ts` | `createTransportInstance()`, `createMultiTransportInstance()`, `registerGracefulShutdown()` — `flush()`, `close()`, signal handling |

---

## 5. Logger Initialization and Lifecycle

### Startup

1. `createLogger(options)` receives `LoggerOptions` (`mode`, `context`, `serializers`, `redaction`, `childBindings`, `destination`, `pino`).
2. `defineConfig()` resolves Pino options for the mode: `development` → `trace`, `production` → `info`, `test` → `silent`. Redaction is active in every mode.
3. `createSerializers()` builds `req`, `res`, `err` serializer functions from `SerializerOptions` (`excludeQueryString`, `excludeHeaders`, `excludeQuery`, `headerAllowlist`, `normalizeAuth`).
4. `installSafeChild()` wraps the Pino instance's `child` method so all child bindings are redacted before Pino pre-serializes them.
5. `pino(loggerOptions, destination)` creates the real Pino logger. `destination` is passed as the second positional argument because Pino ignores a `destination` key inside the options object.
6. If `childBindings` are provided, `logger.child(childBindings)` is called (with redacted bindings).

### Runtime

Every `logger.info(payload, msg)` call flows through:
1. Pino merges `base` (pid, hostname, context), `level`, `timestamp`.
2. `formatters.log` → `redactDeep` walker masks sensitive keys, strips URL query strings, converts BigInts, preserves Errors.
3. Pino serializers (`req`, `res`, `err`) process the redacted object.
4. `redact.paths` (fast-redact) masks post-serialization header fields.
5. `JSON.stringify` serializes the result.
6. The line is written to the destination stream.

### Shutdown

For transports created via `createTransportInstance` / `createMultiTransportInstance`:
- `flush()` waits for pending writes to drain.
- `close()` releases transport resources.
- `registerGracefulShutdown(transport, { exitCode, signals })` installs `SIGTERM`/`SIGINT` handlers that call `flush()`, `close()`, then `process.exit(exitCode)`. Returns a cleanup function to remove handlers.

If the underlying transport does not support `flush` or `close`, those methods resolve immediately.

---

## 6. Pino Integration and Logging Pipeline

### Pino version and usage

- Peer/runtime dependency: `pino` `^10.4.0`.
- Returned instances are `pino.Logger` with the full Pino API.
- The package sets `formatters.log`, `formatters.level`, `timestamp`, `redact`, and `serializers` in Pino options. The redaction formatter is re-applied after any caller-supplied `pino.formatters` override so a custom formatter cannot silently drop redaction.
- `pino` serializers are set to the package's custom `req`, `res`, `err` serializers.

### Pipeline order (verified in source)

```
formatters.log  → redactLogObject   [runs first, on the raw payload]
pino serializers → createSerializers [runs second, on walker output]
redact.paths    → fast-redact        [runs last, on serializer output]
JSON.stringify  → destination
```

### Why `formatters.log` runs before serializers

Framework-parsed query objects are own enumerable properties on the request. The walker sees them first and masks `query.token` before `createSerializers` copies `query` into the emitted line. If redaction ran after serializers, the serializer's output could still contain secrets that `redact.paths` does not cover.

### Why `redact.paths` is still needed

Fields that only exist *after* serialization — most notably `res.headers` — are invisible to the walker. Pino's native `redact.paths` (fast-redact stringifiers) covers `req.headers.*` and `res.headers.*` for `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`. These paths are frozen to prevent cross-logger mutation.

### Error handling in the pipeline

- Throwing getters and `Proxy` ownKeys traps are caught per-property; unreadable properties are skipped rather than aborting the log call.
- Circular references are tolerated via a `WeakSet` seen-set; self-referencing objects are returned as-is.
- Extreme nesting (50,000+ levels) does not stack overflow because `maxDepth` (default 100) halts recursion beyond the boundary.

---

## 7. Log Levels and Environment-Specific Behavior

| Mode | Level | Notes |
|------|-------|-------|
| `development` | `trace` | Verbose local output capturing all log levels |
| `production` | `info` | Default mode; structured JSON output with ISO timestamps and PID/hostname |
| `test` | `silent` | Silences output to keep test runner reports clean |

Redaction is applied in **every** mode, including `test` and `silent`. A secret must not reach a terminal or CI log just because the run is local.

Pino options can override `level` via `pino.level` on the `LoggerOptions.pino` escape hatch. Presets remain fully overridable.

---

## 8. Redaction Architecture and Sensitive-Data Protection

### Default sensitive keys

The following keys are matched **case-insensitively** at any nesting depth and replaced with `"[REDACTED]"` (or a custom `replacement`):

- **Passwords:** `password`, `passwordhash`, `password_hash`, `passwd`, `pwd`
- **Tokens:** `token`, `accesstoken`, `refreshtoken`, `idtoken`, `sessiontoken`, `sessionid`
- **Secrets:** `secret`, `clientsecret`, `client_secret`
- **Keys:** `privatekey`, `private_key`, `apikey`, `api_key`
- **Auth & cookies:** `authorization`, `proxy-authorization`, `cookie`, `set-cookie`

### URL query stripping

Query strings are stripped from any field whose name indicates a URL (`url`, `originalUrl`, `requestUrl`, `href`, `referer`, `referrer`), regardless of depth or casing:

```typescript
logger.info({ url: "https://api.example.com/checkout?token=secret123" });
// Emitted: { "url": "https://api.example.com/checkout" }
```

A field that contains `?` but is not URL-bearing (e.g. `note: "why did this fail?"`) is left untouched. The key set is explicit rather than pattern-based to avoid truncating non-URL data.

### BigInt safety

`BigInt` values are converted to strings (`String(value)`) during redaction so `JSON.stringify` cannot throw and precision is preserved:

```typescript
logger.info({ accountNumber: 12345678901234567890n });
// Emitted: { "accountNumber": "12345678901234567890" }
```

### Error preservation

The walker preserves Error identity so pino's `err` serializer still recognizes the object:
- Prototype is preserved (`Object.create(prototype)` + `safeShallowCopyPreserving`).
- Non-enumerable own properties (`message`) are copied.
- Accessors (`stack`) are read once and stored as data properties.
- Throwing accessors are skipped rather than aborting the call.

### Custom rules

Rules match by key name (case-insensitive) or path regex (tested against dot-joined key path). A rule can supply:
- `mask`: override the replacement string.
- `handler`: a function `(value, key, context) => unknown` that transforms the value. If the handler throws, the configured mask is used instead (never the original secret).

Handler context includes `path` (string array), `depth`, and `isBinding`.

---

## 9. Redaction Rules, Custom Keys, Handlers, and Configuration

`RedactionConfig` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `keys` | `string[]` | `undefined` | Additional case-insensitive sensitive keys |
| `rules` | `RedactionRule[]` | `undefined` | Named rules matched by key or path regex |
| `maxDepth` | `number` | `100` | Maximum recursion depth (1–10000) |
| `replacement` | `string` | `"[REDACTED]"` | Replacement string for redacted values |
| `audit` | `AuditConfig` | `undefined` | Emit redaction events to a separate sink |
| `headerAllowlist` | `string[]` | `undefined` | Only listed headers pass through; others redacted |
| `normalizeAuth` | `boolean` | `false` | Always redact `Authorization` headers |

`RedactionRule` fields:

| Field | Type | Description |
|-------|------|-------------|
| `keys` | `string[]` | Key names to match (case-insensitive) |
| `path` | `RegExp` | Path pattern tested against dot-joined key path |
| `handler` | `RedactionHandler` | Custom value transformation before masking |
| `mask` | `string` | Override replacement string for this rule |

`AuditConfig` fields:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `boolean` | Whether audit events are emitted |
| `sink` | `DestinationStream` | Writable stream for audit events |
| `eventLevel` | `"warn" \| "info"` | Audit event level (default `"warn"`) |

`SerializerOptions` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `excludeQuery` | `boolean` | `false` | Omit the parsed `req.query` object |
| `excludeHeaders` | `boolean` | `false` | Omit headers from serialized req/res |
| `excludeQueryString` | `boolean` | `true` | Strip query parameters from `req.url` and omit `req.queryString` |
| `headerAllowlist` | `string[]` | `undefined` | Only listed headers pass through |
| `normalizeAuth` | `boolean` | `false` | Always redact `Authorization` headers |

---

## 10. Child Logger Behavior and Binding Redaction

### The problem

Pino serializes child bindings into a pre-built JSON string at child-creation time. They never reach `formatters.log` or `redact.paths`. Without intervention, `logger.child({ apiKey: "secret" })` writes the secret in plaintext.

### The solution

`installSafeChild()` wraps the Pino instance's `child` method:

1. `redactBindings()` masks sensitive keys in the bindings object using the same walker (`bindingsMode = true`).
2. The original Pino `child` method is called with the redacted bindings.
3. The wrapper is installed on the root instance. Pino builds children with `Object.create(this)`, so the own `child` property is inherited by the whole tree.
4. `Symbol.for("@oneunit/logger.safeChild")` marks wrapped instances to prevent redundant wrapping.
5. The original `child` is captured from the prototype and invoked with `this`, so nested children keep inherited bindings.

### What is redacted vs what is not

- **Plain object bindings** (`{ apiKey, requestId }`): sensitive keys are masked.
- **Plain objects nested inside bindings** (`{ meta: { password } }`): walked and masked.
- **Arrays inside bindings** (`{ users: [{ token }] }`): walked and masked.
- **Non-plain object bindings** (`{ req: new UserModel() }`): treated as opaque leaves, passed by reference. Properties on class instances are **not** masked.
- **URL fields inside bindings** (`{ url: "/pay?token=leak" }`): query string stripped.

### `createChildLogger` and `withContext`

- `createChildLogger(logger, bindings)`: calls `logger.child(bindings)` with redaction applied. No-op (returns the same logger) for empty bindings.
- `withContext(logger, context)`: returns a new child logger with context merged into bindings (immutable; original unchanged). Context values are redacted.

---

## 11. HTTP Serializers and Request/Response Handling

### `createSerializers(options)`

Returns `{ req, res, err }` serializer functions for Pino's `serializers` option.

#### Request serializer fields

| Field | Source | Notes |
|-------|--------|-------|
| `id` | Pino std serializer | Request ID |
| `method` | `request.method` | HTTP method |
| `url` | Sanitized | Query string stripped by default (`excludeQueryString: true`) |
| `host` | `request.host` → `request.hostname` → `headers.host` | Fallback chain; first value of repeated header |
| `hostname` | `request.hostname` | |
| `correlationId` | `headers["x-correlation-id"] | | |
| `remoteAddress` | `request.remoteAddress` → `socket.remoteAddress` | |
| `remotePort` | `request.remotePort` → `socket.remotePort` | |
| `protocol` | `request.protocol` | |
| `headers` | Processed | Sensitive headers redacted per allowlist/normalizeAuth |
| `query` | Parsed query object | Sensitive keys masked; omitted if empty |
| `queryString` | Raw query string | Omitted by default; emitted only when `excludeQueryString: false` and non-empty |

#### Response serializer fields

| Field | Source | Notes |
|-------|--------|-------|
| `statusCode` | `response.statusCode` | Omitted if null or uncommitted |
| `headers` | Processed | Sensitive headers redacted per allowlist/normalizeAuth |

#### Error serializer fields

| Field | Source | Notes |
|-------|--------|-------|
| `type` | `error.constructor.name` | |
| `message` | `error.message` | |
| `stack` | `error.stack` | |
| `cause` | `error.cause` | Walked recursively, cycle-safe (max 50 depth) |
| `errors` | `AggregateError.errors` | Serialized per error |
| own enumerable | Custom metadata | Sensitive keys masked by upstream walker |

### Header processing

- `normalizeAuth: true` rewrites `Authorization` (any casing) to `[REDACTED]`.
- `headerAllowlist: [...]` passes only listed headers (case-insensitive match); all others are redacted.
- Both options can be set on the serializer or inherited from `LoggerOptions.redaction` via `createHttpLogger`.

### Defaults favor non-disclosure

- `excludeQueryString: true` — query strings are stripped from URLs.
- Raw `queryString` field is omitted by default.
- Sensitive headers are redacted by default via `redact.paths` even without serializer options.

---

## 12. Error Serialization, Causes, Metadata, and Circular References

The custom `err` serializer:

1. Emits `type` (constructor name), `message`, `stack`.
2. Copies own enumerable properties (custom metadata attached via `Object.assign`).
3. Walks the `cause` chain recursively, cycle-safe via a `Set<Error>` with max depth 50.
4. Serializes `AggregateError.errors` per error.

Sensitive metadata attached to errors is masked by the `formatters.log` walker **before** the serializer runs, so `instanceof Error` identity and stack traces are preserved while secrets are redacted.

Cycle tolerance: if `error.cause` references an ancestor error, the `seen` set breaks the chain and serialization terminates gracefully.

---

## 13. Configuration Validation and Presets

### `validateConfig(options)`

Returns `{ valid: boolean, errors: [{ field, message, suggestion? }] }`. Does not throw.

Validated checks:
- `mode` must be `"development"`, `"production"`, or `"test"`.
- `redaction.maxDepth` must be an integer between 1 and 10000.
- `redaction.keys` entries must be non-empty strings.
- `redaction.rules` entries must specify at least one of `keys`, `path`, or `handler`; `path` must be a `RegExp` instance.
- `redaction.headerAllowlist` entries must be non-empty strings.

### `validateConfigOrThrow(options)`

Throws on the first error, suitable for application startup checks.

### Presets

| Preset | Level | Key behaviors |
|--------|-------|---------------|
| `presets.production()` | `info` | Header allowlisting (`content-type`, `content-length`, `user-agent`), auth normalization |
| `presets.development()` | `trace` | Verbose local output, full redaction active |
| `presets.test()` | `silent` | Minimal silent output, full redaction active |
| `presets.ci()` | `silent` | Audit enabled (`eventLevel: "warn"`), strict header allowlisting (`content-type`) |

`resolvePreset(name, options)` resolves and validates configuration. `createLoggerFromPreset(name, options)` asynchronously creates a logger from a preset. Presets are convenience defaults, not restrictions — all Pino options remain overridable.

---

## 14. Transport Architecture and Transport Limitations

### Transport targets

| Target | Pino target | Destination type | Notes |
|--------|-------------|------------------|-------|
| `pretty` | `pino-pretty` | string path or Writable stream | Optional peer `pino-pretty` required |
| `file` | `pino/file` | string file path | Requires `destination` path |
| `stream` | `pino/file` | Writable stream | Requires `destination` stream |

### Multi-transport

`createMultiTransport()` combines multiple target definitions with per-target log levels. `createMultiTransportInstance()` wraps the result with unified `flush()` and `close()`.

### Known transport limitations

**In-memory Writable streams through `pino.transport()` throw `DataCloneError`.** `pino.transport()` runs in a worker thread that cannot clone a `Writable` stream. This affects `createTransportInstance` / `createMultiTransportInstance` with target `"stream"` and an in-memory `Writable` destination.

**Workarounds:**
- Pass the stream directly to `pino(stream)` (no transport).
- Use a file-path destination (`target: "file"` with a string path).
- Use `"stream"` target with a string file path (Pino's `pino/file` accepts string destinations).

**Pretty transport requires `pino-pretty`.** It is an optional peer dependency. If missing, a descriptive error is produced at transport creation time.

---

## 15. Flush, Close, and Graceful Shutdown

### `createTransportInstance(options)`

Wraps `pino.transport()` and adds:
- `flush(): Promise<void>` — waits for pending writes to drain. Resolves immediately if the transport has no `flush`.
- `close(): Promise<void>` — releases transport resources. Resolves immediately if the transport has no `end`.

### `createMultiTransportInstance(transports)`

Same lifecycle for multi-destination transports.

### `registerGracefulShutdown(transport, options)`

| Option | Type | Default |
|--------|------|---------|
| `exitCode` | `number` | `0` |
| `signals` | `NodeJS.Signals[]` | `["SIGTERM", "SIGINT"]` |

On signal: `await transport.flush()`, `await transport.close()`, `process.exit(exitCode)`. Flush/close failures are caught and do not prevent shutdown. Returns a cleanup function to remove handlers.

Signal-handler tests run in isolated contexts to avoid terminating the main test runner.

---

## 17. Audit Logging and Security Considerations

### Audit events

When `redaction.audit` is enabled, each redaction emits an event to the configured sink:

```json
{
  "event": "redaction",
  "key": "password",
  "path": ["user", "password"],
  "depth": 1,
  "isBinding": false,
  "timestamp": "2026-11-05T10:30:00.000Z",
  "level": "warn"
}
```

The secret value is never included. Audit sink write failures are swallowed.

### Security boundaries

**What is protected:**
- Default sensitive keys at any depth, in arrays, any casing.
- Custom keys and rules.
- URL query strings in `url`/`originalUrl`/`requestUrl`/`href`/`referer`/`referrer`.
- HTTP headers (via serializer processing + `redact.paths`).
- Child bindings.
- Error metadata (custom properties on `Error` objects).
- Context values (via `base` redaction).
- Audit events (no secrets emitted).

**What is NOT protected (documented limitations):**
- Properties on non-plain object bindings (class instances, model instances, sockets, streams). These are opaque leaves.
- Internal framework diagnostic log lines (outside package control).
- Secrets in `console.log`, `process.stdout.write`, or other non-Pino output.

---

## 18. Performance and Memory Considerations

### Cost model (measured)

| Path | Approximate cost | Notes |
|------|-----------------|-------|
| No-match `redactLogObject` | ~1.55 µs/call | Zero allocation; original reference returned |
| Whole logging path | ~3.5 µs/call | Includes Pino overhead |
| Full deep walk of live object graph | ~26.8 µs/call | Avoided by design for non-plain bindings |
| Non-plain binding pass-through | ~0.7 µs/call | Flat regardless of graph size |

### Performance assertions

Performance tests assert **shape** (relative ratios and graph traversal boundaries), not absolute wall-clock times, avoiding flakiness across CI environments.

### Memory

- Copy-on-write means no allocation on the no-match path.
- Only changed paths are cloned.
- No unbounded memory growth from the redaction walker under sustained load (verified by concurrent logging tests with 1,000+ requests).

---

## 19. Error Handling and Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| Audit sink write fails | Swallowed; log call continues |
| Destination stream write fails | Swallowed; log call continues (no-op `'error'` listener attached) |
| Transport `flush` fails | Caught; shutdown continues |
| Transport `close` fails | Caught; shutdown continues |
| Transport lacks `flush`/`close` | Methods resolve immediately |
| Throwing getter on payload | Property skipped; log call continues |
| `Proxy` ownKeys trap throws | Treated as plain object; log call continues |
| Circular reference | `WeakSet` guard returns reference as-is |
| Extreme nesting (> maxDepth) | Recursion halts; object left untouched beyond boundary |
| Invalid configuration | `validateConfig` returns descriptive errors; `validateConfigOrThrow` throws |
| Missing `pino-pretty` | Descriptive error at pretty transport creation |

---

## 20. Testing Strategy and Quality Assurance

### Test framework

Vitest (`vitest run`). 22 test files, 382 tests.

### Test structure

```
test/
  core/
    api.test.ts                 Public export surface and backwards compatibility
    create-logger-debug.test.ts Logger factory destination streaming
    fuzz.test.ts                Property-based redaction fuzzing with randomized payloads
    performance.test.ts         Cost-shape regressions and object-graph traversal
  logger/
    logger.test.ts              Core logger factory and mode behaviors
    child-logger.test.ts        Child binding redaction, withContext, context inheritance
    security.test.ts            Redaction regression suite, hostile payloads, mutation guards
    custom-rules.test.ts        Custom redaction rules and handlers
    bigint-depth.test.ts        BigInt safety and max depth
    audit.test.ts               Audit mode and CI preset
  http/
    serializers.test.ts         Request, response, and error serializers
    error.test.ts               Cause chains, AggregateError, cycles, metadata
    integration.test.ts         Real HTTP server and serializers
    concurrent.test.ts          Concurrent requests, HTTP error handling
    header-policy.test.ts       Header allowlist, auth normalization, query exclusion
    http/integration.test.ts         HTTP server integration
  transport/
    transport.test.ts           Transport target definitions
    lifecycle.test.ts           Flush, close, graceful shutdown, multi-transport
    shutdown.test.ts            Signal handlers, cleanup, failure handling
  config/
    config-validation.test.ts   Configuration validation and error reporting
    presets.test.ts             Environment presets and overrides
  helpers/
    helpers.ts                  Shared capture utilities, test servers, in-memory collectors
```

### Test guarantees

1. **Emitted output testing:** Tests build loggers through public factories and assert on parsed emitted JSON, never on Pino internal properties.
2. **Performance assertions:** Assert shape (relative ratios), not absolute wall-clock times.
3. **Property-based fuzzing:** Randomly generated nested data structures containing secrets verify the redaction engine never leaks.

### Running tests

```bash
npm test              # Full suite
npm run test:security # Security suite only
npm run test:integration # HTTP server and pino-http integration
npm run test:serializers # Serializer tests
npm run test:api        # Public API surface
npm run test:perf       # Performance regressions
```

---

## 21. Deployment and Production Usage

### Recommended production setup

```typescript
import { createLogger, createTransportInstance, registerGracefulShutdown } from "@oneunit/logger";
import pino from "pino";

const transport = createTransportInstance({
    target: "file",
    destination: "/var/log/app.log",
});

const logger = createLogger({
    mode: "production",
    destination: transport,
    context: {
        service: "payment-service",
        env: "production",
        version: "1.0.0",
    },
    redaction: {
        keys: ["sessionToken", "internalId"],
        normalizeAuth: true,
    },
});

const cleanup = registerGracefulShutdown(transport, { exitCode: 0 });

// Graceful shutdown on process termination
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
```

### CI preset

```typescript
import { createLoggerFromPreset } from "@oneunit/logger";

const logger = await createLoggerFromPreset("ci", {
    service: "ci-service",
    version: "1.0.0",
});
```

CI preset: level `silent`, audit enabled (`warn`), strict header allowlisting (`content-type`), auth normalization.

### Known deployment considerations

- Use file-path destinations with `pino.transport()` for stream targets to avoid `DataCloneError`.
- Direct-stream destinations work via `pino(stream)` without a transport.
- `pino-pretty` is optional; install it only for development pretty printing.
- Supported Node.js: 20+ (per `engines` in `package.json`).

---

## 22. Known Limitations and Future Improvements

### Documented limitations

1. **Non-plain object bindings are not deep-walked.** Class instances, model instances, sockets, and streams bound as values are treated as opaque leaves. Properties on them (e.g. `user.password` on a `UserModel`) are not masked. This is a deliberate performance trade; application developers should redact at call site or bind plain objects.

2. **In-memory Writable streams through `pino.transport()` throw `DataCloneError`.** Use `pino(stream)` directly or a file-path destination instead.

3. **Internal framework diagnostic log lines** (e.g. route-not-found messages echoing raw URLs) are outside the package's redaction pipeline. Package-produced output is clean.

4. **`maxDepth` default is 100.** Objects nested deeper than 100 are not traversed beyond the boundary. This prevents stack overflow on pathological payloads.

### Future improvements (not planned)

None documented. The package is stable at v1.1.0.

---
