import pino from "pino";

import type { TransportLifecycle, TransportOptions } from "../types.js";

import { createTransport } from "./transport.js";

/**
 * Creates a pino transport instance with lifecycle methods for graceful
 * shutdown.
 *
 * Wraps `pino.transport()` and adds `flush()` and `close()` methods that
 * delegate to the underlying transport stream. If the transport does not
 * support flushing or closing, the methods resolve immediately.
 *
 * Example:
 *   const transport = createTransportInstance({
 *       target: "file",
 *       destination: "/var/log/app.log",
 *   });
 *   const logger = pino(transport);
 *   // ... later, on shutdown:
 *   await transport.flush();
 *   await transport.close();
 */
export function createTransportInstance(
    options: TransportOptions = {},
): pino.DestinationStream & TransportLifecycle {
    const transportOptions = createTransport(options);
    const stream = pino.transport(transportOptions) as unknown as pino.DestinationStream & TransportLifecycle;

    const flushFn = (stream as unknown as { flush?: (cb: () => void) => void }).flush;
    stream.flush = (): Promise<void> => {
        if (typeof flushFn !== "function") {
            return Promise.resolve();
        }
        try {
            return new Promise((resolve) => {
                try {
                    flushFn(resolve);
                } catch {
                    resolve();
                }
            });
        } catch {
            return Promise.resolve();
        }
    };

    const endFn = (stream as unknown as { end?: (cb: () => void) => void }).end;
    stream.close = (): Promise<void> => {
        if (typeof endFn !== "function") {
            return Promise.resolve();
        }
        try {
            return new Promise((resolve) => {
                try {
                    endFn(resolve);
                } catch {
                    resolve();
                }
            });
        } catch {
            return Promise.resolve();
        }
    };

    return stream;
}

/**
 * Creates a multi-destination transport instance with lifecycle methods.
 *
 * Combines multiple transport targets into a single pino transport with
 * unified flush and close behavior.
 */
export function createMultiTransportInstance(
    transports: Array<{
        level?: string;
        target: "pretty" | "file" | "stream";
        destination?: NodeJS.WritableStream | string;
        options?: Record<string, unknown>;
    }>,
): pino.DestinationStream & TransportLifecycle {
    const multiOptions = {
        targets: transports.map((t) => ({
            level: t.level,
            target: t.target === "stream" ? "pino/file" : t.target === "pretty" ? "pino-pretty" : "pino/file",
            options: t.target === "stream" || t.target === "file"
                ? { destination: t.destination, ...t.options }
                : { ...t.options },
        })),
    };

    const stream = pino.transport(multiOptions as pino.TransportMultiOptions) as
        unknown as pino.DestinationStream & TransportLifecycle;

    const flushFn = (stream as unknown as { flush?: (cb: () => void) => void }).flush;
    stream.flush = (): Promise<void> => {
        if (typeof flushFn !== "function") {
            return Promise.resolve();
        }
        try {
            return new Promise((resolve) => {
                try {
                    flushFn(resolve);
                } catch {
                    resolve();
                }
            });
        } catch {
            return Promise.resolve();
        }
    };

    const endFn = (stream as unknown as { end?: (cb: () => void) => void }).end;
    stream.close = (): Promise<void> => {
        if (typeof endFn !== "function") {
            return Promise.resolve();
        }
        try {
            return new Promise((resolve) => {
                try {
                    endFn(resolve);
                } catch {
                    resolve();
                }
            });
        } catch {
            return Promise.resolve();
        }
    };

    return stream;
}

/**
 * Registers graceful shutdown handlers for SIGTERM and SIGINT.
 *
 * On signal, flushes and closes the transport, then exits with the given
 * code. Returns a cleanup function to remove the handlers.
 *
 * Example:
 *   const cleanup = registerGracefulShutdown(transport, logger);
 *   process.on("beforeExit", cleanup);
 */
export function registerGracefulShutdown(
    transport: pino.DestinationStream & TransportLifecycle,
    options: { exitCode?: number; signals?: NodeJS.Signals[] } = {},
): () => void {
    const { exitCode = 0, signals = ["SIGTERM", "SIGINT"] } = options;

    const handlers = signals.map((signal) => {
        const handler = async () => {
            try {
                await transport.flush();
            } catch {
                // Flush failure should not prevent shutdown.
            }
            try {
                await transport.close();
            } catch {
                // Close failure should not prevent shutdown.
            }
            process.exit(exitCode);
        };

        process.on(signal, handler);
        return { signal, handler };
    });

    return () => {
        for (const { signal, handler } of handlers) {
            process.off(signal, handler);
        }
    };
}
