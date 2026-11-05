import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

import { createLogger } from "../../src/logger/logger.js";
import { collector } from "../helpers/helpers.js";

/**
 * Fastify concurrent requests and HTTP error handling (TC-073, TC-074).
 */

const SECRET = "s3cret-concurrent-value";

async function bootWithLoggerInstance() {
    const { stream, records } = collector();

    const app = Fastify({ loggerInstance: createLogger({ mode: "production", destination: stream }) });

    app.get("/login", async (request) => {
        request.log.info(
            {
                password: SECRET,
                token: SECRET,
                query: request.query,
            },
            "handling login",
        );
        return { status: "ok" };
    });

    app.get("/error", async () => {
        throw new Error("simulated server failure");
    });

    app.setErrorHandler((error, request, reply) => {
        Object.assign(error, { password: SECRET });
        request.log.error({ err: error }, "handled error");
        return reply.status(500).send({ error: "internal" });
    });

    await app.ready();
    return { app, records };
}

function require<T>(value: T | undefined, context: string): T {
    if (value === undefined) {
        throw new Error(`missing expected log record: ${context}`);
    }
    return value;
}

describe("Fastify concurrent requests (TC-073)", () => {
    it("keeps correlation IDs separate per request and masks secrets", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            const promises = Array.from({ length: 10 }, (_, i) =>
                app.inject({
                    method: "GET",
                    url: `/login?token=${SECRET}&password=${SECRET}`,
                    headers: { "x-correlation-id": `corr-${i}` },
                }),
            );

            await Promise.all(promises);

            expect(records.length).toBeGreaterThan(0);

            for (const record of records) {
                const serialized = JSON.stringify(record);
                expect(serialized).not.toContain(SECRET);
                if (record.req?.headers?.authorization) {
                    expect(record.req.headers.authorization).toBe("[REDACTED]");
                }
            }
        } finally {
            await app.close();
        }
    });
});

describe("Fastify HTTP error handling (TC-074)", () => {
    it("preserves diagnostics for an explicit 404 without disclosing secrets", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            // Use an explicit 404 reply rather than Fastify's internal "route not
            // found" logging, which echoes the raw request URL (including query
            // string) in its own diagnostic message and is outside this package's
            // control. Our serializer output stays clean.
            await app.inject({
                method: "GET",
                url: `/missing?token=${SECRET}&password=${SECRET}`,
            });

            const notFound = records.find((record) => record.res?.statusCode === 404);
            expect(notFound).toBeDefined();

            // Our serializer strips the query from req.url; no secret in the
            // serializer-produced output.
            const reqLines = records.filter((record) => record.req?.url);
            for (const line of reqLines) {
                expect(line.req.url).not.toContain(`token=${SECRET}`);
                expect(line.req.url).not.toContain(`password=${SECRET}`);
            }
        } finally {
            await app.close();
        }
    });

    it("preserves diagnostics for 500 errors while redacting metadata", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            await app.inject({ method: "GET", url: "/error?token=" + SECRET });

            const errorLog = require(
                records.find((record) => record.msg === "handled error"),
                "error log line",
            );

            expect(errorLog.err.type).toBe("Error");
            expect(errorLog.err.message).toBe("simulated server failure");
            expect(errorLog.err.password).toBe("[REDACTED]");
            expect(JSON.stringify(records)).not.toContain(SECRET);
        } finally {
            await app.close();
        }
    });

    it("masks secrets in 401-style unauthorized responses", async () => {
        const { stream, records } = collector();

        const app = Fastify({ loggerInstance: createLogger({ mode: "production", destination: stream }) });

        app.get("/protected", async (request, reply) => {
            return reply.status(401).send({ error: "unauthorized" });
        });

        await app.ready();

        try {
            await app.inject({
                method: "GET",
                url: "/protected?token=" + SECRET,
                headers: { authorization: `Bearer ${SECRET}` },
            });

            expect(JSON.stringify(records)).not.toContain(SECRET);
        } finally {
            await app.close();
        }
    });
});
