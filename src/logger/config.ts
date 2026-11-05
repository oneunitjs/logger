import os from "node:os";
import pino from "pino";

import type {
    AuditConfig,
    CustomRequest,
    CustomResponse,
    LoggerMode,
    RedactionConfig,
    RedactionContext,
    RedactionHandler,
    RedactionRule,
    ResolvedRedactionConfig,
    SerializerOptions,
} from "../types.js";

const CENSOR = "[REDACTED]";

// Keys are compared lowercased, so both `accessToken` and `accesstoken`
// (and any other casing) are covered by a single entry.
const DEFAULT_SENSITIVE_KEYS = new Set([
    "password",
    "passwordhash",
    "password_hash",
    "passwd",
    "pwd",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "sessiontoken",
    "sessionid",
    "secret",
    "clientsecret",
    "client_secret",
    "privatekey",
    "private_key",
    "apikey",
    "api_key",
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
]);

/**
 * Keys whose string value is treated as a URL and has its query string removed.
 *
 * The request serializer strips the query from `req.url`, but an application log
 * that passes a URL directly — `logger.info({ url: request.url })`, a very
 * common shape — bypasses the serializer entirely. Without this, the default
 * "query strings are stripped" guarantee would hold only for the `req` key and
 * silently fail everywhere else, which is the worst possible failure mode for a
 * security default.
 *
 * Compared lowercased, like `SENSITIVE_KEYS`. Restricted to keys that are
 * unambiguously URL-bearing so a non-URL field is not truncated.
 */
const URL_KEYS = new Set([
    "url",
    "originalurl",
    "requesturl",
    "href",
    "referer",
    "referrer",
]);

/**
 * Returns `value` with any query string removed, or `value` unchanged when
 * there is no query.
 *
 * Returning the same reference when nothing changes matters: the caller
 * compares the result with the original to decide whether a copy is needed, so
 * returning a fresh equal string would clone the whole payload on every log
 * call.
 */
function stripQueryString(value: string): string {
    const index = value.indexOf("?");

    if (index === -1) {
        return value;
    }

    // `"/x?"` has an empty query and is left as-is rather than rewritten.
    return index === value.length - 1 ? value : value.slice(0, index);
}

/**
 * Paths handled by pino's `redact` rather than the walker below.
 *
 * `formatters.log` runs *before* pino's serializers, and the serializer then
 * runs on the walker's output. So the walker already sees a framework's parsed
 * `request.query` (an own enumerable property) and masks its sensitive keys
 * before the serializer copies it into the emitted line; a raw
 * `IncomingMessage` has no `query` property at all and `pino-std-serializers`
 * does not parse one out of the URL, so nothing is emitted for it.
 *
 * What the walker cannot see are fields that only exist *after* serialization,
 * such as `res.headers`. These paths cover that gap.
 */
const DEFAULT_REDACT_PATHS: string[] = [
    "req.headers.authorization",
    "req.headers.Authorization",
    "req.headers['proxy-authorization']",
    "req.headers['Proxy-Authorization']",
    "req.headers.cookie",
    "req.headers.Cookie",
    "req.headers['set-cookie']",
    "req.headers['Set-Cookie']",
    "req.headers['x-api-key']",
    "req.headers['X-Api-Key']",
    "req.headers['x-auth-token']",
    "req.headers['X-Auth-Token']",
    "res.headers.authorization",
    "res.headers.Authorization",
    "res.headers.cookie",
    "res.headers.Cookie",
    "res.headers['set-cookie']",
    "res.headers['Set-Cookie']",
    "res.headers['x-api-key']",
    "res.headers['X-Api-Key']",
];

/**
 * Copies own enumerable properties, skipping any that throw when read.
 *
 * Spreading (`{ ...value }`) would evaluate every getter and propagate a
 * thrown error out of the logging call; pino tolerates such payloads by
 * catching during serialization, so redaction must not be stricter.
 */
function safeShallowCopy(value: object, into: Record<string, unknown>): void {
    for (const key of Object.keys(value)) {
        try {
            into[key] = (value as Record<string, unknown>)[key];
        } catch {
            // Unreadable property: leave it out rather than failing the log.
        }
    }

    for (const symbol of Object.getOwnPropertySymbols(value)) {
        try {
            (into as Record<symbol, unknown>)[symbol] = (value as Record<symbol, unknown>)[symbol];
        } catch {
            // Ignore unreadable symbol property.
        }
    }
}

/**
 * Upper bound on recursion. Deeply nested structures beyond this are left
 * untouched rather than risking a stack overflow, which would turn a log call
 * into a process crash. Realistic payloads nest far shallower.
 */
const DEFAULT_MAX_DEPTH = 100;

/** Sentinel meaning "no usable `toJSON` result". */
const NOT_MATERIALIZABLE = Symbol("not-materializable");

/**
 * Invokes a `toJSON` method defensively.
 *
 * Returns `NOT_MATERIALIZABLE` when there is no usable result so the caller
 * can fall back to enumerating own properties. A throwing getter, a
 * non-function `toJSON`, and a `toJSON` that throws must never abort the log
 * call: pino tolerates unserializable payloads during serialization, so
 * redaction must not be stricter.
 */
function materializeToJSON(value: object): unknown {
    let toJSON: unknown;

    try {
        toJSON = (value as { toJSON?: unknown }).toJSON;
    } catch {
        return NOT_MATERIALIZABLE;
    }

    if (typeof toJSON !== "function") {
        return NOT_MATERIALIZABLE;
    }

    try {
        return (toJSON as () => unknown).call(value);
    } catch {
        return NOT_MATERIALIZABLE;
    }
}

/** `Object.keys` that cannot abort the log call on an exotic object. */
function safeKeys(value: object): string[] {
    try {
        return Object.keys(value);
    } catch {
        return [];
    }
}

/**
 * Copies a non-plain object while preserving its prototype and its
 * non-enumerable own properties.
 *
 * This exists for `Error`. `message` is an own but *non-enumerable* data
 * property, so a plain own-enumerable copy drops it. `formatters.log` runs
 * before pino's serializers, so a flattened error reaches the std `err`
 * serializer as a plain object, the serializer no longer recognizes it as an
 * `Error`, and the log line ends up with neither a message nor a stack trace.
 * Keeping the prototype makes the copy pass the serializer's
 * `instanceof Error` check.
 *
 * V8 implements `stack` as an own *accessor* that reads internal
 * `[[ErrorData]]` from its receiver. Copying that accessor onto a different
 * object yields `''`, because the new receiver has no error data, so
 * accessors are read once and stored as plain data properties.
 */
function safeShallowCopyPreserving(value: object, into: Record<string, unknown>): void {
    let descriptors: PropertyDescriptorMap;

    try {
        // One bulk call rather than one `getOwnPropertyDescriptor` per key: on
        // the error path this runs per logged error, and the single call is
        // markedly cheaper than N of them.
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
        return;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
        let defined = false;

        if (descriptor.get || descriptor.set) {
            // Read the accessor once. A throwing getter is skipped rather than
            // aborting the log call, and the value is stored as a data property
            // because the accessor cannot be meaningfully re-bound.
            let accessed: unknown;

            try {
                accessed = (value as Record<string, unknown>)[key];
            } catch {
                accessed = undefined;
            }

            try {
                Object.defineProperty(into, key, {
                    value: accessed,
                    writable: true,
                    enumerable: Boolean(descriptor.enumerable),
                    configurable: true,
                });
                defined = true;
            } catch {
                // Fall through to the plain-assignment fallback below.
            }
        } else {
            try {
                Object.defineProperty(into, key, descriptor);
                defined = true;
            } catch {
                // Non-configurable target slot: fall through to assignment.
            }
        }

        if (!defined) {
            try {
                into[key] = (value as Record<string, unknown>)[key];
            } catch {
                // Leave it out rather than failing the log call.
            }
        }
    }

    for (const symbol of Object.getOwnPropertySymbols(value)) {
        try {
            (into as Record<symbol, unknown>)[symbol] = (value as Record<symbol, unknown>)[symbol];
        } catch {
            // Ignore unreadable symbol property.
        }
    }
}

/**
 * Resolves a `RedactionConfig` into a fully-applied engine configuration.
 *
 * Default keys are always present; caller keys are merged on top. Rules are
 * stored as-is and evaluated at walk time.
 */
export function resolveRedactionConfig(
    config: RedactionConfig = {},
): ResolvedRedactionConfig {
    const keys = new Set(DEFAULT_SENSITIVE_KEYS);

    if (config.keys) {
        for (const key of config.keys) {
            keys.add(key.toLowerCase());
        }
    }

    const headerAllowlist = config.headerAllowlist
        ? new Set(config.headerAllowlist.map((h) => h.toLowerCase()))
        : null;

    return {
        keys,
        rules: config.rules ?? [],
        maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
        replacement: config.replacement ?? CENSOR,
        audit: config.audit ?? null,
        headerAllowlist,
        normalizeAuth: config.normalizeAuth ?? false,
    };
}

/**
 * Creates a redaction engine from a resolved config.
 *
 * The engine exposes `format` (a pino `formatters.log` function),
 * `redactLogObject`, `redactBindings`, and an optional `audit` emitter.
 */
export function createRedactionEngine(
    resolved: ResolvedRedactionConfig,
) {
    const {
        keys: sensitiveKeys,
        rules,
        maxDepth,
        replacement,
        audit,
        headerAllowlist,
        normalizeAuth,
    } = resolved;

    // A sink whose `_write` reports failure through `cb(err)` does not throw
    // from `write()`: Node emits an asynchronous `'error'` event instead,
    // which crashes the process without a listener. Per the audit policy,
    // sink failure must never abort the log call, so swallow sink errors.
    const auditSink = audit?.sink;
    if (audit?.enabled && auditSink) {
        const sink = auditSink as unknown as NodeJS.WritableStream;
        if (typeof sink.on === "function") {
            sink.on("error", () => {});
        }
    }

    /** Emits an audit event when redaction occurs. Never exposes the secret value. */
    const emitAudit = (
        key: string,
        path: string[],
        depth: number,
        isBinding: boolean,
    ): void => {
        if (!audit?.enabled || !audit.sink) {
            return;
        }

        const event = JSON.stringify({
            event: "redaction",
            key,
            path,
            depth,
            isBinding,
            timestamp: new Date().toISOString(),
            level: audit.eventLevel ?? "warn",
        });

        try {
            audit.sink.write(`${event}\n`);
        } catch {
            // Sink write failure must not abort the log call.
        }
    };

    /**
     * Determines whether a key at a given path should be redacted, and if so,
     * what mask to apply. Returns `{ redact, mask, handler }`.
     */
    function resolveKey(
        key: string,
        path: string[],
    ): { redact: boolean; mask: string; handler: RedactionHandler | null } {
        const lowerKey = key.toLowerCase();

        // Check named rules first (most specific wins).
        for (const rule of rules) {
            const keyMatch = rule.keys?.some((k) => k.toLowerCase() === lowerKey);
            const pathMatch = rule.path ? rule.path.test(path.join(".")) : false;

            if (keyMatch || pathMatch) {
                return {
                    redact: true,
                    mask: rule.mask ?? replacement,
                    handler: rule.handler ?? null,
                };
            }
        }

        // Fall back to the default sensitive-key set.
        if (sensitiveKeys.has(lowerKey)) {
            return { redact: true, mask: replacement, handler: null };
        }

        return { redact: false, mask: replacement, handler: null };
    }

    /**
     * Returns a copy of `value` with sensitive keys masked at any depth.
     *
     * Copy-on-write: objects are only cloned along paths that actually change,
     * so the common no-match case allocates nothing and the caller's data is
     * never mutated.
     *
     * Cycles are tolerated via `seen`, so a self-referencing `toJSON` cannot
     * spin forever or fall through unredacted.
     */
    function redactDeep(
        value: unknown,
        seen: WeakSet<object>,
        depth = 0,
        bindingsMode = false,
        path: string[] = [],
    ): unknown {
        if (value === null || depth > maxDepth) {
            return value;
        }

        // BigInt cannot be serialized by JSON.stringify; convert to string
        // safely. This must run before the `typeof value !== "object"` guard
        // below, because `typeof 1n === "bigint"`, not "object".
        if (typeof value === "bigint") {
            return String(value);
        }

        if (typeof value !== "object") {
            return value;
        }

        if (seen.has(value as object)) {
            return value;
        }

        seen.add(value as object);

        try {
            if (Array.isArray(value)) {
                let copy: unknown[] | undefined;

                for (let i = 0; i < value.length; i++) {
                    const current = value[i];
                    const next = redactDeep(
                        current,
                        seen,
                        depth + 1,
                        bindingsMode,
                        [...path, String(i)],
                    );

                    if (next !== current) {
                        copy ??= value.slice();
                        copy[i] = next;
                    }
                }

                return copy ?? value;
            }

            let isPlainObject: boolean;

            try {
                const prototype = Object.getPrototypeOf(value);
                isPlainObject = prototype === null || prototype === Object.prototype;
            } catch {
                // Exotic object (e.g. a Proxy with a throwing trap); treat it as a
                // plain object so a trap cannot abort the log call.
                isPlainObject = true;
            }

            // Plain objects and arrays are the overwhelmingly common case and
            // never carry a `toJSON`, so skip the lookup for them.
            if (!isPlainObject) {
                // In bindings mode a non-plain object (a live request, a model
                // instance) is left alone rather than walked.
                if (bindingsMode) {
                    return value;
                }

                const materialized = materializeToJSON(value);

                if (materialized !== NOT_MATERIALIZABLE) {
                    if (materialized === value) {
                        // `toJSON` returned the receiver. Recursing would hit the
                        // `seen` guard and hand back the *unredacted* original, so
                        // fall through and redact own properties instead.
                    } else if (materialized !== null && typeof materialized === "object") {
                        return redactDeep(materialized, seen, depth + 1, false, path);
                    } else {
                        return materialized;
                    }
                }
            }

            let copy: Record<string, unknown> | undefined;
            let ownToJSON: (() => unknown) | undefined;

            const initCopy = (): Record<string, unknown> => {
                if (copy) {
                    return copy;
                }

                if (isPlainObject) {
                    copy = {};
                    safeShallowCopy(value as object, copy);
                } else {
                    let prototype: object | null;

                    try {
                        prototype = Object.getPrototypeOf(value);
                    } catch {
                        prototype = null;
                    }

                    copy = Object.create(prototype ?? Object.prototype) as Record<string, unknown>;
                    safeShallowCopyPreserving(value as object, copy);
                }

                return copy;
            };

            for (const key of safeKeys(value as object)) {
                let current: unknown;

                try {
                    current = (value as Record<string, unknown>)[key];
                } catch {
                    continue;
                }

                // An own `toJSON` decides the serialized shape, so honour it even
                // on a plain object rather than dropping its output.
                if (key === "toJSON" && typeof current === "function") {
                    ownToJSON = current as () => unknown;
                    continue;
                }

                const { redact, mask, handler } = resolveKey(key, [...path, key]);

                if (redact) {
                    let redactedValue: unknown;

                    if (handler) {
                        try {
                            redactedValue = handler(
                                current,
                                key,
                                { path: [...path, key], depth, isBinding: bindingsMode },
                            );
                        } catch {
                            redactedValue = mask;
                        }
                    } else {
                        redactedValue = mask;
                    }

                    if (audit?.enabled) {
                        emitAudit(key, [...path, key], depth, bindingsMode);
                    }

                    initCopy()[key] = redactedValue;
                    continue;
                }

                // A URL passed straight into a log call carries its query string
                // past the request serializer, so strip it here too. The result is
                // compared by reference below, so a URL with no query costs nothing.
                if (
                    typeof current === "string" &&
                    URL_KEYS.has(key.toLowerCase())
                ) {
                    const stripped = stripQueryString(current);

                    if (stripped !== current) {
                        initCopy()[key] = stripped;
                    }

                    continue;
                }

                const next = redactDeep(
                    current,
                    seen,
                    depth + 1,
                    bindingsMode,
                    [...path, key],
                );

                if (next !== current) {
                    initCopy()[key] = next;
                }
            }

            if (ownToJSON) {
                const materialized = materializeToJSON(value);

                if (materialized !== NOT_MATERIALIZABLE && materialized !== value) {
                    return materialized !== null && typeof materialized === "object"
                        ? redactDeep(materialized, seen, depth + 1, false, path)
                        : materialized;
                }
            }

            return copy ?? value;
        } finally {
            seen.delete(value as object);
        }
    }

    /** Masks sensitive keys anywhere in a log payload. */
    function redactLogObject<T extends Record<string, unknown>>(object: T): T {
        return redactDeep(object, new WeakSet(), 0, false, []) as T;
    }

    /**
     * Masks sensitive keys in logger bindings.
     *
     * Child bindings are serialized into a pre-built JSON string by pino
     * (`asChindings`) at child-creation time, so they never reach
     * `formatters.log` or the `redact` stringifiers. They must be masked here,
     * before `logger.child()` is called.
     */
    function redactBindings(
        bindings: Record<string, unknown>,
    ): Record<string, unknown> {
        return redactDeep(bindings, new WeakSet(), 0, true, []) as Record<string, unknown>;
    }

    /** pino `formatters.log` function. */
    const format = (object: Record<string, unknown>): Record<string, unknown> =>
        redactDeep(object, new WeakSet(), 0, false, []) as Record<string, unknown>;

    return {
        format,
        redactLogObject,
        redactBindings,
        audit: audit?.enabled ? emitAudit : null,
    };
}

/**
 * Returns `headerName` with its value redacted when it matches the allowlist
 * or normalization rules. Returns the original value unchanged when the header
 * should pass through.
 */
function processHeader(
    headerName: string,
    headerValue: unknown,
    headerAllowlist: Set<string> | null,
    normalizeAuth: boolean,
): string | string[] | undefined {
    const lowerName = headerName.toLowerCase();

    // Authorization normalization: always redact bearer tokens.
    if (normalizeAuth && lowerName === "authorization") {
        return CENSOR;
    }

    // Header allowlist: only listed headers pass through; everything else redacted.
    if (headerAllowlist && !headerAllowlist.has(lowerName)) {
        return CENSOR;
    }

    return headerValue as string | string[] | undefined;
}

/**
 * Processes request headers through the allowlist and normalization rules.
 */
function processHeaders(
    headers: Record<string, string | string[] | undefined> | undefined,
    headerAllowlist: Set<string> | null,
    normalizeAuth: boolean,
): Record<string, string | string[] | undefined> | undefined {
    if (!headers) {
        return headers;
    }

    const result: Record<string, string | string[] | undefined> = {};

    for (const [name, value] of Object.entries(headers)) {
        result[name] = processHeader(name, value, headerAllowlist, normalizeAuth);
    }

    return result;
}

export function defineConfig(options: {
    mode?: LoggerMode | undefined;
    context?: { [key: string]: unknown } | undefined;
    customSensitiveKeys?: string[] | undefined;
    redaction?: RedactionConfig | undefined;
} = {}): pino.LoggerOptions {
    const mode = options.mode ?? "production";

    const isProduction = mode === "production";
    const isTest = mode === "test";
    const isDevelopment = mode === "development";
    const isDevOrTest = isDevelopment || isTest;

    const resolvedRedaction = resolveRedactionConfig(options.redaction);

    const defaults: pino.LoggerOptions = {
        level: isDevOrTest ? "trace" : "info",

        base: {
            pid: process.pid,
            hostname: os.hostname(),
            ...(options.context ?? {}),
        },

        formatters: {
            level(label: string) {
                return {
                    level: label,
                };
            },

            log: createRedactionEngine(resolvedRedaction).format,
        },

        timestamp: pino.stdTimeFunctions.isoTime,

        // Redaction is applied in every mode: secrets must never reach a log
        // sink, including local development and test output.
        redact: {
            // Frozen so a caller mutating one logger's config cannot alter
            // every other logger built from this module.
            paths: Object.freeze([...DEFAULT_REDACT_PATHS]) as unknown as string[],
            censor: CENSOR,
            remove: false,
        },
    };

    if (isProduction) {
        return {
            ...defaults,

            level: "info",
        };
    }

    if (isTest) {
        return {
            ...defaults,

            level: "silent",
        };
    }

    return defaults;
}

/** Standalone redaction using default keys (no custom config). */
export function redactLogObject<T extends Record<string, unknown>>(object: T): T {
    return createRedactionEngine(resolveRedactionConfig()).redactLogObject(object);
}

/**
 * Masks sensitive keys in logger bindings using default keys.
 */
export function redactBindings(
    bindings: Record<string, unknown>,
): Record<string, unknown> {
    return createRedactionEngine(resolveRedactionConfig()).redactBindings(bindings);
}

/**
 * Creates a `formatters.log` function that masks sensitive keys using the
 * given key set. Used by `defineConfig` so custom keys are baked into the
 * pino formatter at logger creation time.
 */
export function createRedactFormatter(sensitiveKeys: Set<string>) {
    return (object: Record<string, unknown>): Record<string, unknown> =>
        createRedactionEngine(resolveRedactionConfig({ keys: [...sensitiveKeys] }))
            .format(object);
}

/** Export the engine factory for consumers who need direct access. */
export { processHeaders, CENSOR };
