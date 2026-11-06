import { describe, it, expect } from "vitest";

import { createLogger, createChildLogger, withContext } from "../../src/logger/logger.js";
import { collector, REDACTED } from "../helpers/helpers.js";

describe("child logger: binding redaction inheritance", () => {
    it("masks sensitive child bindings", () => {
        const { logger, records } = collector();

        logger.child({ apiKey: "secret-key", requestId: "r1" }).info("child");

        expect(records[0]!.apiKey).toBe(REDACTED);
        expect(records[0]!.requestId).toBe("r1");
    });

    it("masks bindings on nested children while keeping inherited ones", () => {
        const { logger, records } = collector();

        logger
            .child({ requestId: "r1" })
            .child({ apiKey: "secret-key" })
            .child({ token: "tok123" })
            .info("nested");

        expect(records[0]!.apiKey).toBe(REDACTED);
        expect(records[0]!.token).toBe(REDACTED);
        expect(records[0]!.requestId).toBe("r1");
    });

    it("does not mutate caller's bindings object", () => {
        const { logger } = collector();

        const bindings = { apiKey: "secret-key" };
        logger.child(bindings);

        expect(bindings.apiKey).toBe("secret-key");
    });
});

describe("withContext: immutable context extension", () => {
    it("adds context to a child logger", () => {
        const { logger, records } = collector();

        const requestLogger = withContext(logger, { requestId: "req-123", tenantId: "t1" });
        requestLogger.info("with context");

        expect(records[0]!.requestId).toBe("req-123");
        expect(records[0]!.tenantId).toBe("t1");
    });

    it("does not mutate the original logger", () => {
        const { logger, records } = collector();

        const requestLogger = withContext(logger, { requestId: "req-123" });
        requestLogger.info("child with context");

        // Original logger should not have requestId
        logger.info("original");
        expect(records[1]!.requestId).toBeUndefined();
    });

    it("masks sensitive context values", () => {
        const { logger, records } = collector();

        const requestLogger = withContext(logger, {
            requestId: "req-123",
            sessionToken: "s3cret-token",
        });
        requestLogger.info("with sensitive context");

        expect(records[0]!.sessionToken).toBe(REDACTED);
        expect(records[0]!.requestId).toBe("req-123");
    });

    it("is a no-op for empty context", () => {
        const { logger } = collector();

        const result = withContext(logger, {});
        expect(result).toBe(logger);
    });
});

describe("createLogger: context in base", () => {
    it("includes service and env in base bindings", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            context: { service: "payment-service", env: "production", version: "1.2.0" },
            destination: stream,
        });

        logger.info("context in base");

        expect(records[0]!.service).toBe("payment-service");
        expect(records[0]!.env).toBe("production");
        expect(records[0]!.version).toBe("1.2.0");
        expect(records[0]!.pid).toBe(process.pid);
        expect(records[0]!.hostname).toBeDefined();
    });
});
