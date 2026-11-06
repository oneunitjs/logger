# @oneunit/logger

High-performance, secure-by-default structured logging built on [Pino](https://getpino.io). Engineered for microservices, HTTP APIs, and enterprise applications with deep automatic redaction, URL sanitization, transport lifecycle management, and zero-allocation copy-on-write paths.

[![GitHub](https://img.shields.io/badge/GitHub-oneunitjs%2Flogger-181717?logo=github)](https://github.com/oneunitjs/logger)
[![CI](https://github.com/oneunitjs/logger/actions/workflows/ci.yml/badge.svg)](https://github.com/oneunitjs/logger/actions/workflows/ci.yml)
[![Security](https://github.com/oneunitjs/logger/actions/workflows/security.yml/badge.svg)](https://github.com/oneunitjs/logger/actions/workflows/security.yml)
[![npm version](https://img.shields.io/npm/v/@oneunit/logger.svg?color=blue)](https://www.npmjs.com/package/@oneunit/logger)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue.svg)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Table of Contents

- [What Problem Does It Solve?](#what-problem-does-it-solve)
- [Main Features](#main-features)
- [Architecture & Pipeline](#architecture--pipeline)
- [Supported Environments](#supported-environments)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Standardized Context](#standardized-context)
- [Subpath Exports](#subpath-exports)
- [HTTP Logging & Serializers](#http-logging--serializers)
  - [Request & Response Serializers](#request--response-serializers)
  - [Serializers & Error Tracking](#serializers--error-tracking)
- [Transports & Multi-Destination Dispatch](#transports--multi-destination-dispatch)
  - [Pretty Transport](#pretty-transport)
  - [File & Stream Transports](#file--stream-transports)
  - [Multi-Target Routing](#multi-target-routing)
  - [Lifecycle Management & Graceful Shutdown](#lifecycle-management--graceful-shutdown)
- [Environment Presets](#environment-presets)
- [Configuration Validation](#configuration-validation)
- [Security & Redaction Engine](#security--redaction-engine)
  - [Default Sensitive Keys](#default-sensitive-keys)
  - [Custom Keys & Pattern Rules](#custom-keys--pattern-rules)
  - [URL Query Stripping](#url-query-stripping)
  - [Safe Child Bindings](#safe-child-bindings)
  - [Header Allowlisting & Auth Normalization](#header-allowlisting--auth-normalization)
  - [Audit Logging](#audit-logging)
  - [Performance & Non-Plain Object Scope](#performance--non-plain-object-scope)
- [CI/CD & Automation Workflows](#cicd--automation-workflows)
  - [Workflow Matrix Overview](#workflow-matrix-overview)
  - [1. CI Pipeline (`ci.yml`)](#1-ci-pipeline-ciyml)
  - [2. Release & Publishing (`publish.yml`)](#2-release--publishing-publishyml)
  - [3. Security & Dependency Scanning (`security.yml`)](#3-security--dependency-scanning-securityyml)
  - [4. Issue Triage Automation (`bug-report.yml`)](#4-issue-triage-automation-bug-reportyml)
  - [5. AI & Commit Summary (`ai-summary.yml`)](#5-ai--commit-summary-ai-summaryyml)
- [Development & Testing](#development--testing)
  - [Available Scripts](#available-scripts)
  - [Test Directory Structure](#test-directory-structure)
  - [Runnable Examples](#runnable-examples)
- [Production Best Practices & Troubleshooting](#production-best-practices--troubleshooting)
- [API Reference](#api-reference)
  - [Exported Functions](#exported-functions)
  - [Exported Types](#exported-types)
- [License](#license)

---

## What Problem Does It Solve?

Standard logging libraries log whatever data is passed into them. In real-world applications, credentials, tokens, session IDs, cookies, and authorization headers frequently leak into log sinks via:

1. **Direct payloads**: Objects containing `password`, `token`, `apiKey`, or `secret`.
2. **URL queries**: URLs containing query parameters (`/checkout?token=secret123`), logged either as strings or via framework request objects.
3. **Child logger bindings**: `logger.child({ apiKey })` pre-serializes bindings, bypassing standard formatters.
4. **HTTP headers**: `Authorization`, `Proxy-Authorization`, and `Cookie` headers logged on incoming or outgoing requests.
5. **Errors & cause chains**: Nested `Error.cause` chains or custom metadata attached to errors.

`@oneunit/logger` makes redaction the default across **all modes** (`production`, `development`, and `test`). Every logger returned is a native `pino.Logger` instance with full ecosystem compatibility, zero performance penalty on clean paths, and comprehensive diagnostics.

---

## Main Features

| Feature | Description |
| :--- | :--- |
| **Pino Powered** | Returns standard `pino.Logger` instances with full Pino API speed and ecosystem access |
| **Deep Redaction** | Case-insensitive recursive masking of sensitive keys across plain objects and arrays at arbitrary nesting depths |
| **Active in Every Mode** | Redaction runs in `production`, `development`, and `test` alike — secrets never leak to local terminals or test runners |
| **URL Query Sanitization** | Automatically strips query strings from URL fields (`url`, `originalUrl`, `requestUrl`, `href`, `referer`, `referrer`) |
| **Safe Child Loggers** | Child bindings are redacted before Pino pre-serializes them, preventing credential leaks in `logger.child({ apiKey })` |
| **Diagnostic Preservation** | Preserves `Error.prototype`, non-enumerable `message`, `stack` accessors, and `instanceof Error` identity |
| **Recursive Error Chains** | Fully serializes `Error.cause` chains (cycle-tolerant), `AggregateError.errors`, and metadata; converts `BigInt` safely |
| **Copy-on-Write** | Allocates copies only along modified paths; clean payloads allocate zero extra objects and caller inputs are never mutated |
| **HTTP Ready** | Built-in request, response, and error serializers with correlation ID tracking and `pino-http` middleware support |
| **Transport Builders** | First-class builder for `pretty`, `file`, and `stream` transports with multi-destination dispatch and per-target levels |
| **Transport Lifecycle** | Asynchronous `flush()` and `close()` methods for graceful shutdown, plus `registerGracefulShutdown()` for OS signals |
| **Startup Validation** | `validateConfig()` and `validateConfigOrThrow()` with actionable suggestions for early configuration verification |
| **Environment Presets** | Built-in presets for `production`, `development`, `test`, and `ci` with sensible security defaults |
| **Modular Subpaths** | Clean entry points for `/logger`, `/config`, `/http`, `/serialize`, `/transport`, `/presets`, and `/config-validation` |

---

## Architecture & Pipeline

Redaction and serialization run in a strictly coordinated sequence to ensure no leaks occur between stages:

```text
caller calls logger.info(payload)
        │
        ▼
formatters.log  ──►  redactLogObject (recursive walker)          [Runs FIRST]
        │            • Masks sensitive keys at arbitrary depth
        │            • Strips query strings from URL fields
        │            • Preserves Error prototype and accessors
        ▼
pino serializers ──► createSerializers (req / res / err)         [Runs SECOND]
        │            • Serializes req (host, headers, correlation ID)
        │            • Serializes res (statusCode, headers)
        │            • Serializes err (cause chains, AggregateError)
        ▼
redact.paths    ──►  fast-redact stringifiers                   [Runs LAST]
        │            • Masks post-serialization headers (res.headers)
        ▼
JSON.stringify  ──►  destination stream
```

1. **The walker runs first**: Framework-parsed queries have sensitive properties masked before `createSerializers` copies them into the emitted line.
2. **Errors are preserved**: The walker preserves error prototypes, non-enumerable properties (`message`), and accessors (`stack`) so that errors pass Pino's internal `instanceof Error` checks without loss of diagnostic context.
3. **`redact.paths` covers post-serialization headers**: Fields that only exist after serialization (such as `res.headers`) are masked by fast-redact paths.

For full architectural deep-dives, see [ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Supported Environments

- **Node.js**: `>=20.0.0` (tested on Node 20, 22, and 24)
- **TypeScript**: `^5.9.x` (target ES2022, NodeNext module resolution)
- **Pino**: `^10.4.0`
- **pino-http**: `^11.0.0`
- **pino-std-serializers**: `^7.1.0`
- **pino-pretty**: `^13.2.0` (optional peer dependency)

---

## Installation

```bash
npm install @oneunit/logger
```

### Optional Pretty Printing

For local terminal development with colorized output, install `pino-pretty` as a development dependency:

```bash
npm install -D pino-pretty
```

---

## Quick Start

```typescript
import { createLogger } from "@oneunit/logger";

const logger = createLogger({ mode: "development" });

logger.info("Service initialized");
logger.warn({ latencyMs: 340 }, "Database query took longer than threshold");
logger.error(new Error("Connection reset"), "Upstream service failure");

// Child loggers automatically inherit parent configuration and redact bindings
const child = logger.child({ requestId: "req-123", apiKey: "secret_live_key" });
child.info("Handling request");
// Output:
// {"level":"info","time":"...","requestId":"req-123","apiKey":"[REDACTED]","msg":"Handling request"}
```

---

## Standardized Context

Attach persistent service metadata, environment indicators, tenant IDs, and correlation IDs across all log records:

```typescript
import { createLogger, withContext } from "@oneunit/logger";

const logger = createLogger({
    mode: "production",
    context: {
        service: "payment-service",
        env: "production",
        version: "1.2.0",
    },
});

// Create an immutable child logger with request context
const requestLogger = withContext(logger, {
    requestId: "req-abc",
    correlationId: "corr-xyz",
    tenantId: "tenant-001",
});

requestLogger.info("Transaction approved");
// Output:
// {
//   "level": "info",
//   "service": "payment-service",
//   "env": "production",
//   "version": "1.2.0",
//   "requestId": "req-abc",
//   "correlationId": "corr-xyz",
//   "tenantId": "tenant-001",
//   "msg": "Transaction approved"
// }
```

---

## Subpath Exports

Import modular components directly using granular subpath exports defined in `package.json`:

```typescript
// Core logger factory & child utilities
import { createLogger, withContext } from "@oneunit/logger/logger";

// Configuration helpers & low-level redaction
import { defineConfig, redactLogObject, resolveRedactionConfig } from "@oneunit/logger/config";

// Configuration validation
import { validateConfig, validateConfigOrThrow } from "@oneunit/logger/config-validation";

// HTTP middleware
import { createHttpLogger } from "@oneunit/logger/http";

// Serializers (req, res, err)
import { createSerializers } from "@oneunit/logger/serialize";

// Environment presets
import { presets, createLoggerFromPreset } from "@oneunit/logger/presets";

// Transport definitions & targets
import { createTransport, createMultiTransport } from "@oneunit/logger/transport";
```

| Subpath | Target File | Exported Utilities |
| :--- | :--- | :--- |
| `@oneunit/logger` | `src/index.ts` | Complete public API surface, transport lifecycle utilities, and re-exported Pino types |
| `@oneunit/logger/logger` | `src/logger/logger.ts` | `createLogger`, `createChildLogger`, `withContext` |
| `@oneunit/logger/config` | `src/logger/config.ts` | `defineConfig`, `redactLogObject`, `redactBindings`, `createRedactionEngine`, `resolveRedactionConfig`, `createRedactFormatter`, `processHeaders`, `CENSOR` |
| `@oneunit/logger/config-validation` | `src/config-validation.ts` | `validateConfig`, `validateConfigOrThrow` |
| `@oneunit/logger/http` | `src/http/middleware.ts` | `createHttpLogger` |
| `@oneunit/logger/serialize` | `src/http/serializers.ts` | `createSerializers` |
| `@oneunit/logger/presets` | `src/presets.ts` | `presets`, `resolvePreset`, `createLoggerFromPreset` |
| `@oneunit/logger/transport` | `src/transport/transport.ts` | `createTransport`, `createMultiTransport` |

---

## HTTP Logging & Serializers

### Request & Response Serializers

`createHttpLogger` wraps `pino-http` with security-hardened serializers for any Node HTTP server:

```typescript
import http from "node:http";
import { createLogger, createHttpLogger } from "@oneunit/logger";

const logger = createLogger({ mode: "production" });
const httpLogger = createHttpLogger({
    logger,
    serializers: {
        excludeQueryString: true, // Strips query parameters from req.url
    },
});

const server = http.createServer((req, res) => {
    req.log.info({ password: "raw_password" }, "Processing request"); // Masked automatically
    res.end("ok");
});

server.use(httpLogger);
server.listen(3000);
```

### Serializers & Error Tracking

`createSerializers` provides robust sanitization for requests, responses, and errors:

- **Request Serializer (`req`)**: Emits `id`, `method`, `url` (sanitized), `host`, `hostname`, `correlationId` (from `x-correlation-id`), `remoteAddress`, `remotePort`, `protocol`, `headers` (allowlisted/redacted), and `query`.
- **Response Serializer (`res`)**: Emits `statusCode` (omitted if uncommitted/null to prevent noise) and `headers`.
- **Error Serializer (`err`)**:
  - Recursively serializes `Error.cause` chains (up to 50 levels deep, cycle-tolerant).
  - Serializes `AggregateError.errors` arrays.
  - Preserves custom properties attached via `Object.assign`.
  - Converts `BigInt` values safely to string primitives.

```typescript
import { createSerializers } from "@oneunit/logger/serialize";

const serializers = createSerializers({
    excludeQueryString: true,
    normalizeAuth: true,
    headerAllowlist: ["content-type", "user-agent", "x-request-id"],
});

// Recursive error serialization example
const rootCause = new Error("Database connection timeout");
const appError = new Error("Failed to process transaction", { cause: rootCause });
Object.assign(appError, { txId: "TX-9981", token: "secret-token" });

logger.error({ err: appError }, "Payment processing failed");
// Result:
// err.type: "Error"
// err.message: "Failed to process transaction"
// err.txId: "TX-9981"
// err.token: "[REDACTED]"
// err.cause: { type: "Error", message: "Database connection timeout", ... }
```

---

## Transports & Multi-Destination Dispatch

### Pretty Transport

Format logs into human-readable terminal output:

```typescript
import pino from "pino";
import { createLogger, createTransport } from "@oneunit/logger";

const transport = pino.transport(createTransport({
    target: "pretty",
    level: "debug",
}));

const logger = createLogger({ destination: transport });
```

### File & Stream Transports

```typescript
import { createLogger, createTransport } from "@oneunit/logger";
import pino from "pino";

// File logging
const fileTransport = pino.transport(createTransport({
    target: "file",
    destination: "/var/log/app/service.log",
    level: "info",
}));

const logger = createLogger({ destination: fileTransport });
```

### Multi-Target Routing

Dispatch logs to multiple sinks simultaneously with independent log levels:

```typescript
import pino from "pino";
import { createLogger, createMultiTransport } from "@oneunit/logger";

const multi = pino.transport(createMultiTransport([
    { target: "pretty", level: "info" },
    { target: "file", destination: "/var/log/app/debug.log", level: "debug" },
    { target: "file", destination: "/var/log/app/error.log", level: "error" },
]));

const logger = createLogger({ destination: multi });
```

### Lifecycle Management & Graceful Shutdown

Transports created via `pino.transport()` run in dedicated worker threads. `createTransportInstance` and `createMultiTransportInstance` attach asynchronous `flush()` and `close()` lifecycle methods:

```typescript
import pino from "pino";
import {
    createTransportInstance,
    registerGracefulShutdown,
} from "@oneunit/logger";

const transport = createTransportInstance({
    target: "file",
    destination: "/var/log/app/application.log",
});

const logger = pino(transport);

// Automatically catch SIGTERM and SIGINT, flush buffers, close streams, and exit
const unregister = registerGracefulShutdown(transport, { exitCode: 0 });

// Or manually flush and close during custom shutdown routines:
await transport.flush();
await transport.close();
```

---

## Environment Presets

Quickly initialize loggers with standardized, environment-specific configurations:

```typescript
import { createLoggerFromPreset, presets } from "@oneunit/logger";

// Production preset: level info, header allowlisting, auth normalization
const prodLogger = await createLoggerFromPreset("production", {
    service: "auth-service",
    version: "2.1.0",
});

// Or customize via createLogger and spread preset settings:
const devLogger = createLogger({
    ...presets.development({ service: "auth-service" }),
    level: "debug",
});
```

| Preset | Level | Key Behaviors |
| :--- | :--- | :--- |
| `presets.production()` | `info` | Structured JSON, header allowlisting (`content-type`, `content-length`, `user-agent`), authorization normalization, redaction enabled |
| `presets.development()` | `trace` | Verbose output capturing all log levels, full redaction active |
| `presets.test()` | `silent` | Minimal silent output to prevent noisy test reports, full redaction active |
| `presets.ci()` | `silent` | Audit logging enabled (`warn` level), strict header allowlisting (`content-type`) |

---

## Configuration Validation

Validate configuration options at application startup to prevent silent failures:

```typescript
import { validateConfig, validateConfigOrThrow } from "@oneunit/logger/config-validation";

// Non-throwing inspection:
const result = validateConfig({
    mode: "staging" as any, // Invalid
    redaction: { maxDepth: 50000 }, // Invalid
});

if (!result.valid) {
    console.error(result.errors);
    // [
    //   { field: "mode", message: "Invalid mode...", suggestion: "Use mode: \"production\"..." },
    //   { field: "redaction.maxDepth", message: "maxDepth above 10000...", suggestion: "..." }
    // ]
}

// Fail-fast assertion at startup:
validateConfigOrThrow({
    mode: "production",
    redaction: { maxDepth: 50 },
});
```

---

## Security & Redaction Engine

### Default Sensitive Keys

The following keys are matched **case-insensitively** at any nesting depth and replaced with `"[REDACTED]"` (or your custom `replacement`):

- **Passwords**: `password`, `passwordhash`, `password_hash`, `passwd`, `pwd`
- **Tokens**: `token`, `accesstoken`, `refreshtoken`, `idtoken`, `sessiontoken`, `sessionid`
- **Secrets**: `secret`, `clientsecret`, `client_secret`
- **Keys**: `privatekey`, `private_key`, `apikey`, `api_key`
- **Auth & Cookies**: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`
- **Post-Serialization Header Paths**: `req.headers.*` and `res.headers.*` for `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`

### Custom Keys & Pattern Rules

Configure additional sensitive keys or define advanced redaction rules with regex patterns and value transformation handlers:

```typescript
import { createLogger } from "@oneunit/logger";

const logger = createLogger({
    redaction: {
        keys: ["ssn", "creditCardNumber", "internalSecret"],
        rules: [
            // Rule 1: Custom replacement mask
            {
                keys: ["creditCardNumber"],
                mask: "[CARD_MASKED]",
            },
            // Rule 2: Regex path matching (e.g., config.credentials.token)
            {
                path: /credentials\..*token$/i,
                mask: "[TOKEN_REDACTED]",
            },
            // Rule 3: Custom transformation handler
            {
                keys: ["email"],
                handler: (value, key, context) => {
                    const str = String(value);
                    const [user, domain] = str.split("@");
                    return `${user?.slice(0, 2)}***@${domain}`;
                },
            },
        ],
        maxDepth: 50,
        replacement: "[REDACTED]",
    },
});
```

### URL Query Stripping

Query strings are stripped from all fields whose name suggests a URL (`url`, `originalUrl`, `requestUrl`, `href`, `referer`, `referrer`):

```typescript
logger.info({ url: "https://api.internal/v1/users?token=secret_123&session=xyz" });
// Output:
// {"level":"info","time":"...","url":"https://api.internal/v1/users"}
```

### Safe Child Bindings

Pino creates child bindings with `asChindings` at initialization time, bypassing runtime formatters. `@oneunit/logger` wraps `logger.child()` on the prototype:

```typescript
const child = logger.child({
    service: "worker",
    apiKey: "prod-secret-key",
});

child.info("Job completed");
// apiKey is safely replaced with "[REDACTED]" in child output
```

### Header Allowlisting & Auth Normalization

```typescript
const logger = createLogger({
    redaction: {
        normalizeAuth: true, // Always sets Authorization: "[REDACTED]"
        headerAllowlist: ["content-type", "user-agent", "x-correlation-id"],
    },
});
```

### Audit Logging

Emit structured audit events whenever redaction occurs without ever revealing the secret value:

```typescript
import { Writable } from "node:stream";

const auditSink = new Writable({
    write(chunk, _enc, cb) {
        console.warn("AUDIT:", chunk.toString().trim());
        cb();
    },
});

const logger = createLogger({
    redaction: {
        audit: {
            enabled: true,
            sink: auditSink,
            eventLevel: "warn",
        },
    },
});
```

### Performance & Non-Plain Object Scope

- **Copy-on-write**: Objects without sensitive keys are returned directly without memory allocation (~1.55 µs/call). Clones are created only along modified branches.
- **Plain Data Traversal**: Plain objects and arrays are traversed recursively up to `maxDepth` (default: 100).
- **Non-Plain Object Boundary**: Class instances, sockets, streams, and complex prototypes are passed by reference and **not** deep-walked to avoid traversing massive runtime object graphs (e.g. `req.socket -> parser -> stream`). Bind plain objects or redact at the call site.

---

## CI/CD & Automation Workflows

The repository includes five automated GitHub Actions workflows located in `.github/workflows/`:

### Workflow Matrix Overview

```text
.github/workflows/
├── ci.yml          ──► Lint, typecheck (src/tests/examples), build, multi-node tests, tarball validation
├── publish.yml     ──► Tag-driven OIDC Trusted Publishing, version parity, and pre-publish matrix verification
├── security.yml    ──► Weekly & push audit, security test matrix, and TruffleHog secret scanning
├── bug-report.yml  ──► Automatic bug issue labeling, triage assignment, and author notification
└── ai-summary.yml  ──► Pull request & commit range diff summary extraction with multiline safety
```

| Workflow | File | Triggers | Key Responsibilities & Highlights |
| :--- | :--- | :--- | :--- |
| **CI Pipeline** | [ci.yml](file:///home/lucius/Documents/logger/.github/workflows/ci.yml) | `push`, `pull_request` (`main`, `master`) | Typecheck (`src`, `tests`, `examples`), build, test matrix on Node `20`, `22`, `24`, subpath export verification, tarball packing and isolated import test |
| **Publish & Release** | [publish.yml](file:///home/lucius/Documents/logger/.github/workflows/publish.yml) | `push` (tags: `logger-v*`, `v*`) | Pre-publish verification on Node `20`, `22`, `24`, git tag vs `package.json` version parity check, npm OIDC Trusted Publishing with provenance |
| **Security Scanning** | [security.yml](file:///home/lucius/Documents/logger/.github/workflows/security.yml) | `push`, `pull_request`, `schedule` (`weekly`) | Dependency audit (`npm audit --audit-level=high`), dedicated security regression suite on Node `20`, `22`, `24`, TruffleHog deep commit history scan |
| **Bug Report Triage** | [bug-report.yml](file:///home/lucius/Documents/logger/.github/workflows/bug-report.yml) | `issues` (`opened`, `reopened`, `labeled`) | Automatic triage labeling, automated maintainer acknowledgment comment, duplicate-trigger and infinite-loop guards |
| **AI / Diff Summary** | [ai-summary.yml](file:///home/lucius/Documents/logger/.github/workflows/ai-summary.yml) | `push`, `pull_request` | Deep checkout (`fetch-depth: 0`), multiline-safe GITHUB_OUTPUT parsing, changed file extraction for pull requests and commits |

---

### 1. CI Pipeline (`ci.yml`)

The primary continuous integration pipeline executes on every push and pull request targeting `main` or `master`. It is split into five distinct jobs:

1. **`lint-and-typecheck`**:
   - Runs on `ubuntu-latest` with Node 20.
   - Executes `npm run typecheck:src` (source files via `tsconfig.json`).
   - Executes `npm run typecheck` (test suites via `tsconfig.test.json`).
   - Executes `npm run typecheck:examples` (examples via `tsconfig.examples.json`).
2. **`build`**:
   - Compiles TypeScript to `dist/`.
   - Validates the existence of all 8 primary subpath export files (`dist/index.js`, `dist/logger/config.js`, `dist/http/middleware.js`, `dist/logger/logger.js`, `dist/http/serializers.js`, `dist/transport/transport.js`, `dist/config-validation.js`, `dist/presets.js`).
3. **`test`**:
   - Matrix execution across supported Node runtimes: `["20", "22", "24"]`.
   - Executes the complete Vitest test suite (`npm test`).
4. **`pack-check`**:
   - Runs `npm run pack:check` (dry-run package packaging).
   - Generates a real `.tgz` tarball using `npm pack`.
   - Sets up an isolated scratch project in `/tmp/tarball-test`, installs the packed tarball, and runs a live Node script to verify that `@oneunit/logger` and all subpath exports (`/config`, `/http`, `/serialize`, `/logger`, `/presets`, `/transport`, `/config-validation`) resolve correctly at runtime.
5. **`ci`**:
   - Aggregates status across all upstream jobs.

---

### 2. Release & Publishing (`publish.yml`)

Automates releases to npm upon pushing a version tag (`git tag logger-v1.0.0` or `git tag v1.0.0`):

1. **`verify`**:
   - Executes across Node `["20", "22", "24"]`.
   - **Version Parity Check**: Extracts the version from the git tag (`logger-v1.2.3` -> `1.2.3`) and asserts that it matches `package.json`'s `version`. If there is a mismatch, the workflow halts immediately before publish.
   - Performs full source and test typechecking.
   - Executes complete test suites.
   - Builds and verifies clean tarball installation in an isolated directory.
2. **`publish`**:
   - Triggered only after the `verify` job succeeds.
   - Configured with `permissions: id-token: write` and `contents: read` for **npm OIDC Trusted Publishing**.
   - Publishes the package with cryptographic provenance:
     ```bash
     npm publish --access public --provenance
     ```

---

### 3. Security & Dependency Scanning (`security.yml`)

Runs on every push, pull request, and on a recurring schedule every Monday at 06:00 UTC:

1. **`dependency-audit`**:
   - Runs `npm audit --audit-level=high` against the project lockfile.
2. **`security-tests`**:
   - Runs the dedicated security regression suite (`npm run test:security`) across Node `["20", "22", "24"]`.
   - Validates that hostile payloads, prototype pollution vectors, nested secrets, circular references, and child bindings never leak secrets.
3. **`secret-scan`**:
   - Checks out the entire commit history (`fetch-depth: 0`).
   - Executes [TruffleHog](https://github.com/trufflesecurity/trufflehog) to detect leaked secrets, keys, or credentials.
   - Employs [.trufflehogignore](./.trufflehogignore) to exclude synthetic test fixtures in `test/`.

---

### 4. Issue Triage Automation (`bug-report.yml`)

Automates initial handling of community issue submissions:

- Triggered on issues when `opened`, `reopened`, or `labeled`.
- Condition: Checks if the issue has the `bug` label and does not already have the `triage` label.
- Automatically applies the `triage` label using `actions/github-script@v7`.
- Posts a welcoming response requesting minimal reproductions and relevant environment snippets.
- Prevents infinite loops and duplicate comments on subsequent issue label changes.

---

### 5. AI & Commit Summary (`ai-summary.yml`)

Summarizes file modifications across pull requests and branch pushes:

- Triggered on pushes and pull requests to `main` and `master`.
- Checks out full git history (`fetch-depth: 0`).
- Gathers changed files between PR base/head commits or recent push commits (`HEAD~1 HEAD`).
- Uses multiline-safe `GITHUB_OUTPUT` delimiter syntax (`files<<EOF ... EOF`) to prevent truncation or script injection.

---

## Development & Testing

```bash
# Install dependencies
npm install

# Run full local verification (build, typecheck, examples, test, pack check)
npm run verify
```

### Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm run build` | `tsc -p tsconfig.json` | Compiles TypeScript source files to `dist/` |
| `npm run dev` | `tsc -w -p tsconfig.json` | Runs TypeScript compiler in watch mode |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json` | Typechecks source and test files |
| `npm run typecheck:src` | `tsc -p tsconfig.json --noEmit` | Typechecks source code only |
| `npm run typecheck:examples`| `tsc -p tsconfig.examples.json` | Typechecks runnable example files |
| `npm test` | `vitest run` | Executes all test suites |
| `npm run test:watch` | `vitest` | Executes test runner in watch mode |
| `npm run test:security` | `vitest run test/logger/security.test.ts` | Runs deep security and redaction regression tests |
| `npm run test:integration` | `vitest run test/http/integration.test.ts` | Runs HTTP and `pino-http` server integration tests |
| `npm run test:serializers` | `vitest run test/http/serializers.test.ts` | Runs serializer unit tests |
| `npm run test:api` | `vitest run test/core/api.test.ts` | Asserts public API surface backward compatibility |
| `npm run test:perf` | `vitest run test/core/performance.test.ts` | Verifies cost-shape and non-traversal boundaries |
| `npm run pack:check` | `npm pack --dry-run` | Verifies published package file inclusions |
| `npm run verify` | `...` | Full local CI check (build, typecheck, test, pack check) |

### Test Directory Structure

The test suite is structured by subsystem to ensure isolation and fast feedback:

```text
test/
├── core/
│   ├── api.test.ts                 # Validates all 21 root exports and Pino interface
│   ├── create-logger-debug.test.ts # Destination stream piping verification
│   ├── fuzz.test.ts                # Property-based randomized payload fuzzing
│   └── performance.test.ts         # Cost-shape and traversal ratio benchmarks
├── logger/
│   ├── logger.test.ts              # Core logger modes (production, development, test)
│   ├── child-logger.test.ts        # Child binding redaction and context inheritance
│   └── security.test.ts            # Security regression suite (casing, mutation, errors)
├── http/
│   ├── serializers.test.ts         # Request, response, and error serializers
│   ├── error.test.ts               # Error cause chains, AggregateError, cycles
│   └── integration.test.ts         # Real HTTP server and pino-http tests
├── transport/
│   ├── transport.test.ts           # Transport target configuration and options
│   └── shutdown.test.ts            # Flush, close, and OS signal shutdown handlers
├── config/
│   └── config-validation.test.ts   # Configuration validation rules and suggestions
└── helpers/
    └── helpers.ts                  # Shared collectors, in-memory sinks, mock servers
```

### Runnable Examples

Test the package in real application setups:

```bash
npm run build
npm run example            # Core walkthrough: modes, redaction, child loggers, errors
npm run example:http       # Real HTTP server with sanitized queries and headers
```

---

## Production Best Practices & Troubleshooting

| Scenario / Issue | Recommended Practice / Fix |
| :--- | :--- |
| **Destination Setup** | Pass `destination` as a top-level option: `createLogger({ destination: stream })`. Passing `{ pino: { destination } }` is silently ignored by Pino. |
| **Worker Transports** | When using `createTransport({ target: "file" })` with `pino.transport()`, use string file paths. In-memory streams cannot be transferred across thread boundaries. |
| **Graceful Shutdown** | Always call `registerGracefulShutdown(transport)` in production deployments to ensure logs in memory buffers are drained before process exit. |
| **Startup Validation** | Add `validateConfigOrThrow(options)` at application entry points to fail fast on invalid options. |
| **Class Model Logging** | To redact properties on class instances (e.g. `UserModel`), pass plain JavaScript objects or use custom redaction handlers. |

---

## API Reference

### Exported Functions

All 21 functions are directly available from the root package `@oneunit/logger`:

| Function | Subpath Source | Description |
| :--- | :--- | :--- |
| `createLogger(options?)` | `./logger` | Creates a Pino logger with env-aware defaults, redaction, and safe child wrapping |
| `createChildLogger(logger, bindings?)` | `./logger` | Safely creates a child logger (no-op when bindings are empty) |
| `withContext(logger, context)` | `./logger` | Returns an immutable child logger with merged context metadata |
| `createHttpLogger(options?)` | `./http` | `pino-http` middleware with pre-configured request, response, and error serializers |
| `createSerializers(options?)` | `./serialize` | Builds request, response, and error serializers with sanitization |
| `defineConfig(options?)` | `./config` | Generates Pino configuration options for development, production, and test |
| `redactLogObject(object)` | `./config` | Pure utility to mask sensitive keys in an object without mutating original input |
| `redactBindings(bindings)` | `./config` | Masks sensitive keys in logger child bindings |
| `resolveRedactionConfig(config?)` | `./config` | Resolves a partial RedactionConfig into a complete ResolvedRedactionConfig |
| `createRedactionEngine(resolved)` | `./config` | Instantiates a low-level redaction engine with format and mask utilities |
| `createRedactFormatter(sensitiveKeys)` | `./config` | Creates a `formatters.log` function incorporating custom sensitive keys |
| `createTransport(options?)` | `./transport` | Builds a Pino transport target definition (`pretty`, `file`, or `stream`) |
| `createMultiTransport(transports)` | `./transport` | Builds a multi-target Pino transport definition with per-target levels |
| `createTransportInstance(options?)` | `./` | Transport wrapper with `flush()` and `close()` lifecycle methods |
| `createMultiTransportInstance(transports)`| `./` | Multi-destination transport with unified lifecycle methods |
| `registerGracefulShutdown(transport, options?)` | `./` | Registers SIGTERM/SIGINT handlers that flush and close transports before exiting |
| `validateConfig(options)` | `./config-validation` | Validates logger configuration, returning errors and suggestions without throwing |
| `validateConfigOrThrow(options)` | `./config-validation` | Validates logger configuration, throwing on first detected misconfiguration |
| `presets` | `./presets` | Object holding preset factory methods (`production`, `development`, `test`, `ci`) |
| `resolvePreset(presetName, options?)` | `./presets` | Resolves and validates configuration for a given preset name |
| `createLoggerFromPreset(presetName, options?)`| `./presets` | Asynchronously resolves, validates, and creates a logger from a preset |

### Exported Types

| Type | Description |
| :--- | :--- |
| `Logger` | Re-exported alias for `pino.Logger` |
| `Level` | Re-exported alias for `pino.Level` (`"fatal"` \| `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"`) |
| `LevelWithSilent` | Re-exported alias for `pino.LevelWithSilent` |
| `DestinationStream` | Re-exported alias for `pino.DestinationStream` |
| `LoggerMode` | Logger environment mode (`"development"` \| `"production"` \| `"test"`) |
| `LoggerOptions` | Configuration options for `createLogger` |
| `LogContext` | Standardized contextual metadata attached to every log line |
| `RedactionConfig` | Redaction engine configuration options |
| `ResolvedRedactionConfig` | Fully resolved redaction configuration |
| `RedactionRule` | Named redaction rule matching by keys or path regex |
| `RedactionHandler` | Custom value transformation handler before masking |
| `RedactionContext` | Context metadata passed to a `RedactionHandler` |
| `RedactionStats` | Redaction statistics (masked count, walked count, paths) |
| `AuditConfig` | Configuration for emitting redaction events to an audit sink |
| `HttpLoggerOptions` | Configuration options for `createHttpLogger` |
| `SerializerOptions` | Options controlling header, query, and query string emission |
| `CustomRequest` | Request interface accepted by `createSerializers().req` |
| `CustomResponse` | Response interface accepted by `createSerializers().res` |
| `TransportOptions` | Options for `createTransport` and `createTransportInstance` |
| `TransportTarget` | Individual target definition within `createMultiTransport` |
| `TransportLifecycle` | Lifecycle interface with `flush()` and `close()` |
| `TransportPresetOptions` | Options for transport preset factories |
| `EnvPreset` | Environment preset name (`"development"` \| `"production"` \| `"test"` \| `"ci"`) |
| `EnvPresetOptions` | Preset options (`service`, `version`, `level`) |
| `ConfigValidationError` | Structured configuration error with field, message, and suggestion |
| `ConfigValidationResult` | Validation outcome holding boolean `valid` and `errors` array |

---

## License

MIT © 2026 OneUnit (oneunitjs)
