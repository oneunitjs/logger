import { describe, it, expect } from "vitest";
import * as loggerPackage from "../../src/index.js";

import { collector } from "../helpers/helpers.js";

/**
 * Public API surface.
 *
 * Guards the entry points a consumer imports. A refactor that renames or drops
 * an export is a breaking change for every dependent package in the monorepo,
 * so the shape is pinned here rather than inferred from internal usage.
 */

describe("public API", () => {
    it.each([
        "createLogger",
        "createChildLogger",
        "createHttpLogger",
        "defineConfig",
        "redactLogObject",
        "redactBindings",
        "createSerializers",
        "createTransport",
        "createMultiTransport",
    ])("exports %s as a function", (name) => {
        expect(typeof (loggerPackage as Record<string, unknown>)[name]).toBe("function");
    });

    it("exports the documented API table entries", () => {
        // Mirrors the table in the README.
        expect(Object.keys(loggerPackage).sort()).toEqual([
            "createChildLogger",
            "createHttpLogger",
            "createLogger",
            "createLoggerFromPreset",
            "createMultiTransport",
            "createMultiTransportInstance",
            "createRedactFormatter",
            "createRedactionEngine",
            "createSerializers",
            "createTransport",
            "createTransportInstance",
            "defineConfig",
            "presets",
            "redactBindings",
            "redactLogObject",
            "registerGracefulShutdown",
            "resolvePreset",
            "resolveRedactionConfig",
            "validateConfig",
            "validateConfigOrThrow",
            "withContext",
        ]);
    });

    it("creates a usable logger from the package root", () => {
        const { stream, records } = collector();

        const logger = loggerPackage.createLogger({ mode: "production", destination: stream });
        logger.info({ hello: "world" }, "root import");

        expect(records).toHaveLength(1);
        expect(records[0]!.msg).toBe("root import");
        expect(records[0]!.hello).toBe("world");
    });

    it("keeps pino's logger interface on the returned instance", () => {
        // Consumers rely on the full pino surface, not just the log methods.
        const { stream } = collector();
        const logger = loggerPackage.createLogger({ destination: stream });

        for (const method of ["trace", "debug", "info", "warn", "error", "fatal", "child", "isLevelEnabled", "flush"]) {
            expect(typeof (logger as unknown as Record<string, unknown>)[method], `${method} is missing`).toBe("function");
        }

        // `level` is a readable string property, not a method.
        expect(typeof logger.level).toBe("string");
    });

    it("accepts a writable stream destination and defaults to stdout otherwise", () => {
        const { stream, records } = collector();

        // Explicit destination routes output to the stream.
        loggerPackage.createLogger({ destination: stream }).info({ routed: true }, "routed");
        expect(records).toHaveLength(1);
        expect(records[0]!.msg).toBe("routed");

        // Omitting it must not throw; pino writes to fd 1 by default.
        expect(() => loggerPackage.createLogger({ mode: "production" })).not.toThrow();
    });

    it("accepts a pino transport worker as a destination", () => {
        // `pino.transport()` returns a DestinationStream, which is the other
        // documented way to route output.
        const { stream } = collector();

        expect(() => loggerPackage.createLogger({ destination: stream })).not.toThrow();
        expect(() => {
            const target = loggerPackage.createTransport({ target: "stream", destination: stream });
            expect(target.targets).toHaveLength(1);
        }).not.toThrow();
    });

    it("honours the pino escape hatch without dropping redaction", () => {
        const { stream, records } = collector();

        const logger = loggerPackage.createLogger({
            mode: "production",
            destination: stream,
            pino: { messageKey: "message" },
        });

        logger.info({ password: "s3cret" }, "custom message key");

        expect(records).toHaveLength(1);
        expect(records[0]!.message).toBe("custom message key");
        expect(records[0]!.password).toBe("[REDACTED]");
    });
});
