import pino from "pino";

import { defineConfig, redactBindings, createRedactionEngine, resolveRedactionConfig } from "./config.js";
import { createSerializers } from "../http/serializers.js";
import type {
    Logger,
    LoggerOptions,
    LogContext,
    RedactionConfig,
    SerializerOptions,
} from "../types.js";

/** Marks a logger whose `child` method has already been wrapped. */
const SAFE_CHILD = Symbol.for("@oneunit/logger.safeChild");

/**
 * Wraps `child` so bindings are redacted however the child is created.
 *
 * pino serializes child bindings into a pre-built JSON string at
 * child-creation time, so they bypass `formatters.log` and `redact`
 * entirely. Redacting inside `createChildLogger` alone would not be enough:
 * `logger.child(...)` is a documented way to make a child, so the method
 * itself is wrapped.
 *
 * pino builds children with `Object.create(this)`, so this own property is
 * inherited by every descendant and a single wrap covers the whole tree. The
 * original method is captured from the prototype and invoked with `this`, so
 * nested children keep their inherited bindings instead of re-rooting.
 */
function installSafeChild(
    logger: pino.Logger,
    redaction?: RedactionConfig,
): pino.Logger {
    const alreadyInstalled = (logger as unknown as Record<symbol, unknown>)[SAFE_CHILD];

    if (alreadyInstalled) {
        return logger;
    }

    const prototype = Object.getPrototypeOf(logger) as pino.Logger | null;
    const originalChild = prototype?.child as
        ((this: pino.Logger, bindings: pino.Bindings, childOptions?: pino.ChildLoggerOptions) => pino.Logger)
        | undefined;

    if (typeof originalChild !== "function") {
        return logger;
    }

    const resolved = resolveRedactionConfig(redaction);
    const engine = createRedactionEngine(resolved);

    Object.defineProperty(logger, SAFE_CHILD, {
        value: true,
        enumerable: false,
        configurable: true,
    });

    Object.defineProperty(logger, "child", {
        value: function safeChild(
            this: pino.Logger,
            bindings: pino.Bindings,
            childOptions?: pino.ChildLoggerOptions,
        ): pino.Logger {
            const safeBindings = bindings && typeof bindings === "object"
                ? engine.redactBindings(bindings as Record<string, unknown>)
                : bindings;

            return originalChild.call(this, safeBindings, childOptions);
        },
        writable: true,
        configurable: true,
        enumerable: false,
    });

    return logger;
}

/**
 * Returns a child logger with additional context merged into bindings.
 *
 * The context is redacted before being bound, so sensitive context values
 * never reach the sink. The original logger is unchanged.
 */
export function withContext(
    logger: pino.Logger,
    context: Partial<LogContext>,
): pino.Logger {
    if (!context || Object.keys(context).length === 0) {
        return logger;
    }

    return logger.child(context as Record<string, unknown>);
}

export function createLogger(options: LoggerOptions = {}): Logger {
    const {
        mode,
        serializers,
        childBindings,
        context,
        redaction,
        pino: pinoOptions,
        destination,
    } = options;

    const loggerOptions = defineConfig({
        mode,
        context,
        redaction,
    });
    const customSerializers = createSerializers(serializers);

    // `formatters` is excluded from the public `pino` option type, but a plain
    // JavaScript caller can still pass one; merge it so a custom formatter
    // cannot silently drop the redaction formatter.
    const overrideFormatters = (pinoOptions as pino.LoggerOptions | undefined)?.formatters;

    const logger = installSafeChild(
        pino({
            ...loggerOptions,

            // Explicit pino overrides are applied last. `level` and `redact` stay
            // overridable by design.
            ...pinoOptions,

            // Re-applied after the overrides: serializers and redaction are
            // security-relevant and must not be replaceable by accident.
            formatters: {
                ...(loggerOptions.formatters ?? {}),
                ...overrideFormatters,
                log: loggerOptions.formatters!.log!,
            },

            serializers: {
                ...loggerOptions.serializers,
                ...customSerializers,
            },

            // pino only accepts a destination as a separate argument, so an
            // options key of the same name is silently ignored.
        }, destination),
        redaction,
    );

    if (childBindings && Object.keys(childBindings).length > 0) {
        return logger.child(childBindings);
    }

    // A destination stream whose `_write` reports failure through `cb(err)`
    // does not throw from `write()`: Node emits an asynchronous `'error'`
    // event instead, which crashes the process without a listener. Pino
    // writes to the destination directly without catching, so a failing
    // destination would otherwise crash the application. Per the failure
    // policy, logging must not abort the process, so swallow destination
    // errors.
    if (destination && typeof (destination as unknown as Record<string, unknown>).on === "function") {
        (destination as unknown as NodeJS.WritableStream).on("error", () => {});
    }

    return logger;
}

export function createChildLogger(
    logger: Logger,
    bindingsOrContext: Record<string, unknown> = {},
): Logger {
    // `logger.child()` throws "missing bindings for child Pino" when called
    // without arguments, so short-circuit the no-op case.
    if (!bindingsOrContext || Object.keys(bindingsOrContext).length === 0) {
        return logger;
    }

    return logger.child(bindingsOrContext);
}
