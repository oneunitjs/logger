import { describe, it, expect } from "vitest";

import { createLogger } from "../../src/logger/logger.js";
import { collector, REDACTED } from "../helpers/helpers.js";

/**
 * Custom redaction rules and handlers (TC-014, TC-015, TC-016).
 *
 * Asserts against emitted output so a rule that masks in isolation but never
 * reaches the sink still fails.
 */

const API_KEY = "s3cret-api-key-value";
const TOKEN = "s3cret-token-value";

describe("custom rule: key-based with custom mask (TC-014)", () => {
    it("uses the custom mask for the named key at root level", () => {
        const { logger, records } = captureWithRedaction({
            rules: [{ keys: ["apiKey"], mask: "[API_KEY_HIDDEN]" }],
        });

        logger.info({ apiKey: API_KEY }, "custom mask");

        expect(records[0].apiKey).toBe("[API_KEY_HIDDEN]");
        expect(JSON.stringify(records)).not.toContain(API_KEY);
    });

    it("applies the custom key rule at nested depth", () => {
        const { logger, records } = captureWithRedaction({
            rules: [{ keys: ["sessionToken"], mask: "[TOKEN_HIDDEN]" }],
        });

        logger.info({ user: { sessionToken: TOKEN } }, "nested custom");

        expect(records[0].user.sessionToken).toBe("[TOKEN_HIDDEN]");
    });

    it("applies the custom key rule inside arrays", () => {
        const { logger, records } = captureWithRedaction({
            rules: [{ keys: ["internalId"], mask: "[ID_HIDDEN]" }],
        });

        logger.info({ items: [{ internalId: "id-1" }, { internalId: "id-2" }] }, "array custom");

        expect(records[0].items[0].internalId).toBe("[ID_HIDDEN]");
        expect(records[0].items[1].internalId).toBe("[ID_HIDDEN]");
    });

    it("applies the custom key rule in child bindings", () => {
        const { logger, records } = captureWithRedaction({
            rules: [{ keys: ["sessionToken"], mask: "[TOKEN_HIDDEN]" }],
        });

        logger.child({ sessionToken: TOKEN }).info("child binding custom");

        expect(records[0].sessionToken).toBe("[TOKEN_HIDDEN]");
    });

    it("works in every mode", () => {
        for (const mode of ["production", "development", "test"] as const) {
            const { stream, records } = collector();

            const logger = createLogger({
                mode,
                pino: { level: "trace" },
                destination: stream,
                redaction: {
                    rules: [{ keys: ["apiKey"], mask: "[API_KEY_HIDDEN]" }],
                },
            });

            logger.info({ apiKey: API_KEY }, `mode ${mode}`);

            expect(records[0].apiKey).toBe("[API_KEY_HIDDEN]");
            expect(JSON.stringify(records)).not.toContain(API_KEY);
        }
    });
});

describe("custom rule: regex path (TC-015)", () => {
    it("masks paths matching the regex pattern", () => {
        const { logger, records } = captureWithRedaction({
            rules: [{ path: /\.token$/, mask: "[TOKEN_REDACTED]" }],
        });

        logger.info({
            "access.token": TOKEN,
            "user.token": TOKEN,
            "credentials.token": TOKEN,
            "unrelated": "keep",
        }, "path rule");

        expect(records[0]["access.token"]).toBe("[TOKEN_REDACTED]");
        expect(records[0]["user.token"]).toBe("[TOKEN_REDACTED]");
        expect(records[0]["credentials.token"]).toBe("[TOKEN_REDACTED]");
        expect(records[0].unrelated).toBe("keep");
    });

    it("does not affect non-matching paths", () => {
        const { logger, records } = captureWithRedaction({
            rules: [{ path: /\.token$/, mask: "[TOKEN_REDACTED]" }],
        });

        logger.info({
            "token.value": "keep-me",
            "notoken": "keep-me-too",
        }, "non-matching");

        expect(records[0]["token.value"]).toBe("keep-me");
        expect(records[0].notoken).toBe("keep-me-too");
    });
});

describe("custom rule: handler (TC-016)", () => {
    it("transforms the value via the handler and emits the result", () => {
        const { logger, records } = captureWithRedaction({
            rules: [
                {
                    keys: ["apiKey"],
                    handler: (value) => `hash(${String(value).length})`,
                },
            ],
        });

        logger.info({ apiKey: API_KEY }, "handler");

        expect(records[0].apiKey).toBe(`hash(${API_KEY.length})`);
        expect(JSON.stringify(records)).not.toContain(API_KEY);
    });

    it("passes the expected arguments to the handler", () => {
        let receivedKey: string | undefined;
        let receivedPath: string[] | undefined;
        let receivedDepth: number | undefined;
        let receivedIsBinding: boolean | undefined;

        const { logger, records } = captureWithRedaction({
            rules: [
                {
                    keys: ["apiKey"],
                    handler: (value, key, context) => {
                        receivedKey = key;
                        receivedPath = context.path;
                        receivedDepth = context.depth;
                        receivedIsBinding = context.isBinding;
                        return "masked";
                    },
                },
            ],
        });

        logger.child({ apiKey: API_KEY }).info("handler args");

        expect(receivedKey).toBe("apiKey");
        expect(receivedIsBinding).toBe(true);
        expect(receivedDepth).toBe(0);
        expect(JSON.stringify(records)).not.toContain(API_KEY);
    });

    it("falls back to the mask when the handler throws, never leaking the secret", () => {
        const { logger, records } = captureWithRedaction({
            rules: [
                {
                    keys: ["apiKey"],
                    handler: () => {
                        throw new Error("handler boom");
                    },
                },
            ],
        });

        logger.info({ apiKey: API_KEY }, "handler throws");

        expect(records[0].apiKey).toBe(REDACTED);
        expect(JSON.stringify(records)).not.toContain(API_KEY);
    });
});

function captureWithRedaction(redaction: Parameters<typeof createLogger>[0]["redaction"]) {
    const { stream, records } = collector();

    const logger = createLogger({
        mode: "production",
        destination: stream,
        redaction,
    });

    return { logger, records, stream };
}
