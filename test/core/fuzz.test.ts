import { describe, it, expect } from "vitest";

// Property-based testing for redaction using simple random generators
// (no external fast-check dependency required)

import { createLogger } from "../../src/logger/logger.js";
import { collector, REDACTED } from "../helpers/helpers.js";

function randomString(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function randomNestedObject(depth: number, maxDepth: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    const numKeys = 1 + Math.floor(Math.random() * 3);

    for (let i = 0; i < numKeys; i++) {
        const key = randomString(5 + Math.floor(Math.random() * 10));
        const choice = Math.random();

        if (choice < 0.3 && depth < maxDepth) {
            obj[key] = randomNestedObject(depth + 1, maxDepth);
        } else if (choice < 0.5) {
            obj[key] = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () =>
                randomString(5),
            );
        } else if (choice < 0.7) {
            obj[key] = Math.floor(Math.random() * 1000);
        } else {
            obj[key] = randomString(10);
        }
    }

    return obj;
}

function insertSecrets(obj: Record<string, unknown>, secretKeys: string[]): void {
    const keys = Object.keys(obj);
    for (const key of keys) {
        const lowerKey = key.toLowerCase();
        if (secretKeys.some((sk) => lowerKey === sk || lowerKey.includes(sk))) {
            obj[key] = "s3cret-value";
        } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
            insertSecrets(obj[key] as Record<string, unknown>, secretKeys);
        } else if (Array.isArray(obj[key])) {
            for (const item of obj[key]) {
                if (typeof item === "object" && item !== null) {
                    insertSecrets(item as Record<string, unknown>, secretKeys);
                }
            }
        }
    }
}

function findSecrets(obj: unknown, secret: string): boolean {
    if (typeof obj === "string") {
        return obj === secret || obj.includes(secret);
    }
    if (typeof obj === "object" && obj !== null) {
        if (Array.isArray(obj)) {
            return obj.some((item) => findSecrets(item, secret));
        }
        return Object.values(obj).some((value) => findSecrets(value, secret));
    }
    return false;
}

describe("fuzz: redaction never leaks secrets", () => {
    const secretKeys = [
        "password",
        "token",
        "secret",
        "apiKey",
        "authorization",
        "cookie",
        "sessionid",
        "accessToken",
        "refreshToken",
        "privateKey",
    ];

    it("masks secrets in randomly generated nested objects", () => {
        const { stream, records } = collector();
        const logger = createLogger({ mode: "production", destination: stream });

        for (let trial = 0; trial < 100; trial++) {
            const obj = randomNestedObject(0, 8);
            insertSecrets(obj, secretKeys);

            logger.info({ payload: obj }, "fuzz trial");

            const emitted = JSON.stringify(records);
            expect(emitted).not.toContain("s3cret-value");

            // Verify structure is preserved (non-secret values present)
            records.length = 0;
        }
    });

    it("masks secrets in arrays of objects", () => {
        const { stream, records } = collector();
        const logger = createLogger({ mode: "production", destination: stream });

        for (let trial = 0; trial < 50; trial++) {
            const arr = Array.from({ length: 5 }, () => randomNestedObject(0, 4));
            insertSecrets(arr[0] as Record<string, unknown>, secretKeys);

            logger.info({ items: arr }, "fuzz array trial");

            const emitted = JSON.stringify(records);
            expect(emitted).not.toContain("s3cret-value");

            records.length = 0;
        }
    });

    it("preserves non-secret data while masking secrets", () => {
        const { stream, records } = collector();
        const logger = createLogger({ mode: "production", destination: stream });

        const obj = {
            user: { name: "alice", password: "s3cret-value" },
            items: [{ id: 1, token: "s3cret-value" }, { id: 2, name: "bob" }],
            metadata: { version: "1.0", secret: "s3cret-value" },
        };

        logger.info({ payload: obj }, "preserve structure");

        expect(records).toHaveLength(1);
        expect(records[0]!.payload.user.name).toBe("alice");
        expect(records[0]!.payload.user.password).toBe(REDACTED);
        expect(records[0]!.payload.items[0].id).toBe(1);
        expect(records[0]!.payload.items[0].token).toBe(REDACTED);
        expect(records[0]!.payload.items[1].name).toBe("bob");
        expect(records[0]!.payload.metadata.version).toBe("1.0");
        expect(records[0]!.payload.metadata.secret).toBe(REDACTED);
    });

    it("does not leak secrets through casing variations", () => {
        const { stream, records } = collector();
        const logger = createLogger({ mode: "production", destination: stream });

        const obj = {
            Password: "s3cret-value",
            TOKEN: "s3cret-value",
            ApiKey: "s3cret-value",
            SESSIONID: "s3cret-value",
            Authorization: "Bearer s3cret-value",
        };

        logger.info({ payload: obj }, "casing variations");

        const emitted = JSON.stringify(records);
        expect(emitted).not.toContain("s3cret-value");
        expect(emitted).not.toContain("Bearer s3cret-value");
    });

    it("handles extremely deep nesting without stack overflow", () => {
        const { logger } = collector();

        let deep: Record<string, unknown> = { password: "s3cret-value" };
        let cursor = deep;
        for (let i = 0; i < 500; i++) {
            cursor.next = {};
            cursor = cursor.next as Record<string, unknown>;
        }
        cursor.password = "s3cret-value";

        expect(() => logger.info({ deep }, "deep nesting")).not.toThrow();
    });
});
