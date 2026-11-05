import { describe, it, expect } from "vitest";

import { createLogger } from "../../src/logger/logger.js";
import { collector } from "../helpers/helpers.js";

describe("error serialization: Error.cause chains", () => {
    it("serializes a cause chain recursively", () => {
        const { stream, records } = collector();

        const inner = new Error("inner failure");
        const outer = new Error("outer failure", { cause: inner });

        const logger = createLogger({ mode: "production", destination: stream });
        logger.error({ err: outer }, "caused error");

        expect(records[0].err.type).toBe("Error");
        expect(records[0].err.message).toBe("outer failure");
        expect(records[0].err.cause).toBeDefined();
        expect(records[0].err.cause.type).toBe("Error");
        expect(records[0].err.cause.message).toBe("inner failure");
    });

    it("handles circular cause chains without infinite recursion", () => {
        const { stream, records } = collector();

        const first = new Error("first");
        const second = new Error("second", { cause: first });
        // Intentionally circular: first.cause = second
        (first as Error & { cause?: Error }).cause = second;

        const logger = createLogger({ mode: "production", destination: stream });
        expect(() => logger.error({ err: first }, "circular cause")).not.toThrow();
    });

    it("serializes AggregateError with errors array", () => {
        const { stream, records } = collector();

        const agg = new AggregateError([new Error("err1"), new Error("err2")], "multiple failures");

        const logger = createLogger({ mode: "production", destination: stream });
        logger.error({ err: agg }, "aggregate error");

        expect(records[0].err.type).toBe("AggregateError");
        expect(records[0].err.message).toBe("multiple failures");
        expect(Array.isArray(records[0].err.errors)).toBe(true);
        expect(records[0].err.errors).toHaveLength(2);
        expect(records[0].err.errors[0].message).toBe("err1");
        expect(records[0].err.errors[1].message).toBe("err2");
    });

    it("preserves own enumerable properties on errors", () => {
        const { stream, records } = collector();

        const error = Object.assign(new Error("failed"), { code: "ECONNREFUSED", errno: -111 });

        const logger = createLogger({ mode: "production", destination: stream });
        logger.error({ err: error }, "error with metadata");

        expect(records[0].err.code).toBe("ECONNREFUSED");
        expect(records[0].err.errno).toBe(-111);
    });

    it("masks sensitive metadata attached to errors", () => {
        const { stream, records } = collector();

        const error = Object.assign(new Error("auth failed"), {
            password: "s3cret",
            token: "tok123",
        });

        const logger = createLogger({ mode: "production", destination: stream });
        logger.error({ err: error }, "auth failed");

        expect(records[0].err.password).toBe("[REDACTED]");
        expect(records[0].err.token).toBe("[REDACTED]");
        expect(records[0].err.message).toBe("auth failed");
    });
});
