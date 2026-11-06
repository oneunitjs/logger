import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

import { createLogger } from "../../src/logger/logger.js";
import { createHttpLogger } from "../../src/http/middleware.js";
import { collector } from "../helpers/helpers.js";

/**
 * Fastify integration.
 *
 * These run against the real Fastify 5 server and the real pino logger. The
 * failure mode they exist to catch is silent: `Fastify({ logger: <thing> })`
 * type-checks, starts, and serves requests while Fastify quietly builds its
 * *own* pino instance from whatever it was handed. Nothing throws, and the
 * package's serializers, redaction, and level formatting are simply absent
 * from the output. So every assertion here reads the emitted JSON rather than
 * trusting that the configuration was accepted.
 */

const SECRET = "s3cret-token-value";

/**
 * Boots a Fastify instance with a `loggerInstance` wired to a memory sink.
 *
 * The instance type is inferred rather than annotated: `Fastify({ loggerInstance })`
 * narrows the instance generics to the supplied logger, so a bare
 * `FastifyInstance` annotation would force the server and logger generics back
 * to their defaults and fail to typecheck.
 */
async function bootWithLoggerInstance() {
    const { stream, records } = collector();

    const app = Fastify({ loggerInstance: createLogger({ mode: "production", destination: stream }) });

    app.get("/hello", async (request) => {
        request.log.info({ password: "s3cret-route-password" }, "handling hello");
        return { message: "hello" };
    });

    await app.ready();
    return { app, records };
}

/** Fails loudly, with context, when an expected log line was not emitted. */
function require<T>(value: T | undefined, context: string): T {
    if (value === undefined) {
        throw new Error(`missing expected log record: ${context}`);
    }

    return value;
}

describe("Fastify integration: documented loggerInstance path", () => {
    it("actually uses the package logger and not a Fastify-created one", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            await app.inject({ method: "GET", url: "/hello" });

            expect(records.length, "Fastify emitted nothing through the package logger").toBeGreaterThan(0);
            // Every line must carry this package's `base` and its custom level
            // formatter (a bare `level` string rather than pino's default
            // numeric field). A Fastify-built logger would fail both.
            for (const record of records) {
                expect(record.pid, "missing package base pid").toBe(process.pid);
                expect(typeof record.level, "level was not formatted by the package formatter").toBe("string");
            }
        } finally {
            await app.close();
        }
    });

    it("redacts secrets logged through request.log", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            await app.inject({ method: "GET", url: "/hello" });

            const routeLog = require(records.find((record) => record.msg === "handling hello"), "route log line");
            expect(routeLog.password).toBe("[REDACTED]");
            expect(JSON.stringify(records)).not.toContain("s3cret-route-password");
        } finally {
            await app.close();
        }
    });

    it("strips the query string from Fastify's own request log", async () => {
        // The regression the package must not reintroduce:
        //   expected  query.token = "[REDACTED]"  /  req.url = "/hello"
        //   actual    req.url = "/hello?token=secret"
        const { app, records } = await bootWithLoggerInstance();

        try {
            await app.inject({ method: "GET", url: `/hello?token=${SECRET}` });

            const incoming = require(
                records.find(
                    (record) => typeof record.req?.url === "string" && record.req.url.startsWith("/hello"),
                ),
                `request line; saw ${records.map((r) => r.msg).join(", ")}`,
            );
            expect(incoming.req.url).toBe("/hello");
            expect(JSON.stringify(records), "token leaked through Fastify request logging").not.toContain(SECRET);
        } finally {
            await app.close();
        }
    });

    it("masks sensitive keys in the parsed query while keeping harmless ones", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            await app.inject({ method: "GET", url: `/hello?token=${SECRET}&page=2&foo=bar` });

            const incoming = require(records.find((record) => record.req?.query !== undefined), "request line with a parsed query");

            expect(incoming.req.query.token).toBe("[REDACTED]");
            expect(incoming.req.query.page).toBe("2");
            expect(incoming.req.query.foo).toBe("bar");
        } finally {
            await app.close();
        }
    });

    it("emits an ISO timestamp from the package configuration", async () => {
        const { app, records } = await bootWithLoggerInstance();

        try {
            await app.inject({ method: "GET", url: "/hello" });

            const stamp = records[0]!.time;
            expect(typeof stamp, "no time field").toBe("string");
            // `pino.stdTimeFunctions.isoTime` emits an ISO-8601 string; a
            // Fastify default would still be a string, so assert the format
            // itself rather than the mere presence of the field.
            expect(stamp, `not ISO-8601: ${stamp}`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        } finally {
            await app.close();
        }
    });
});

describe("Fastify integration: the documented anti-pattern fails visibly", () => {
    it("bypasses the package logger entirely when passed via `logger`", async () => {
        // Documents the *wrong* integration on purpose. Fastify 5 types
        // `logger` as `boolean | options`, not as a logger instance, so handing
        // it the pino-http middleware makes Fastify construct a plain pino
        // logger of its own. Every protection this package adds is then
        // absent, and output does not even reach the configured destination.
        //
        // If this test ever stops leaking, the `loggerInstance` guidance in the
        // README has become wrong and needs revisiting.
        const { stream, records } = collector();
        const httpLogger = createHttpLogger({
            logger: createLogger({ mode: "production", destination: stream }),
        });

        // Fastify's own logger writes to stdout, so capture it to keep the
        // suite output clean and to assert on what really got emitted.
        const written: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
            chunk: unknown,
            ...rest: unknown[]
        ) => {
            written.push(String(chunk));
            return (originalWrite as (...args: unknown[]) => boolean)("" as never, ...rest);
        }) as never);

        const app = Fastify({ logger: httpLogger as never });

        app.get("/hello", async (request) => {
            request.log.info({ password: "s3cret-anti-pattern-password" }, "handling hello");
            return { message: "hello" };
        });

        await app.ready();

        try {
            await app.inject({ method: "GET", url: `/hello?token=${SECRET}` });

            // Nothing reached the package's configured destination: Fastify
            // never used the package logger.
            expect(records, "package logger unexpectedly received output").toHaveLength(0);

            const emitted = written.join("");
            const routeLine = require(
                emitted
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => {
                        try {
                            return JSON.parse(line);
                        } catch {
                            return null;
                        }
                    })
                    .find((entry) => entry?.msg === "handling hello"),
                "anti-pattern line on stdout",
            );

            // The leak IS the assertion: the package's protections are absent.
            expect(routeLine.password, "expected an un-redacted password via `logger`").toBe("s3cret-anti-pattern-password");
            expect(emitted).toContain(SECRET);
            // And the package's formatting is gone too.
            expect(routeLine.level, "expected Fastify's numeric level, not the package formatter").toBe(30);
        } finally {
            spy.mockRestore();
            await app.close();
        }
    });
});
