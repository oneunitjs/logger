import { describe, it, expect } from "vitest";

import { createLogger } from "../../src/logger/logger.js";
import { collector } from "../helpers/helpers.js";
import { validateConfig } from "../../src/config-validation.js";

/**
 * BigInt safety and maximum redaction depth (TC-028, TC-029).
 */

describe("BigInt safety (TC-028)", () => {
    it("converts BigInt to a string in emitted output", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
        });

        logger.info({ accountNumber: 12345678901234567890n }, "bigint");

        expect(typeof records[0]!.accountNumber).toBe("string");
        expect(records[0]!.accountNumber).toBe("12345678901234567890");
        expect(() => JSON.parse(JSON.stringify(records))).not.toThrow();
    });

    it("emits valid JSON containing a BigInt alongside other fields", () => {
        const { stream, records } = collector();

        const logger = createLogger({ mode: "production", destination: stream });

        logger.info({
            id: 1,
            accountNumber: 9007199254740991n,
            name: "alice",
        }, "bigint mixed");

        const text = JSON.stringify(records);
        expect(() => JSON.parse(text)).not.toThrow();
        expect(records[0]!.accountNumber).toBe("9007199254740991");
    });

    it("does not throw when BigInt is nested deeply", () => {
        const { stream, records } = collector();

        const logger = createLogger({ mode: "production", destination: stream });

        const payload = { nested: { accountNumber: 12345678901234567890n } };

        expect(() => logger.info(payload, "nested bigint")).not.toThrow();
        expect(JSON.stringify(records)).not.toContain("12345678901234567890n");
    });
});

describe("maximum redaction depth (TC-029)", () => {
    it("redacts within the default max depth of 100", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: { maxDepth: 100 },
        });

        const deep: Record<string, unknown> = {};
        let cursor = deep;
        for (let i = 0; i < 50; i++) {
            cursor.next = {};
            cursor = cursor.next as Record<string, unknown>;
        }
        cursor.password = "buried-secret";

        logger.info({ deep }, "within depth");

        let node: unknown = records[0]!.deep;
        for (let i = 0; i < 50; i++) {
            node = (node as Record<string, unknown>).next;
        }
        expect((node as Record<string, unknown>).password).toBe("[REDACTED]");
    });

    it("accepts a custom max depth and redacts within it", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: { maxDepth: 10 },
        });

        const deep: Record<string, unknown> = {};
        let cursor = deep;
        for (let i = 0; i < 8; i++) {
            cursor.next = {};
            cursor = cursor.next as Record<string, unknown>;
        }
        cursor.password = "within-custom";

        logger.info({ deep }, "custom depth");

        let node: unknown = records[0]!.deep;
        for (let i = 0; i < 8; i++) {
            node = (node as Record<string, unknown>).next;
        }
        expect((node as Record<string, unknown>).password).toBe("[REDACTED]");
    });

    it("does not crash beyond the depth boundary", () => {
        const { logger } = collector();

        const deep: Record<string, unknown> = {};
        let cursor = deep;
        for (let i = 0; i < 150; i++) {
            cursor.next = {};
            cursor = cursor.next as Record<string, unknown>;
        }
        cursor.password = "beyond-default";

        expect(() => logger.info({ deep }, "beyond depth")).not.toThrow();
    });

    it("rejects invalid maxDepth values in validation", () => {
        for (const value of [0, -1, 1.5, NaN, 10001]) {
            const result = validateConfig({ redaction: { maxDepth: value as any } });
            expect(result.valid, `${String(value)} should be rejected`).toBe(false);
        }
    });

    it("accepts boundary maxDepth values in validation", () => {
        for (const value of [1, 100, 10000]) {
            const result = validateConfig({ redaction: { maxDepth: value } });
            expect(result.valid, `${value} should be accepted`).toBe(true);
        }
    });
});
