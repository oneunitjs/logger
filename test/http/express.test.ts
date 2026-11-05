import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger } from "../../src/logger/logger.js";
import { createHttpLogger } from "../../src/http/middleware.js";
import { collector } from "../helpers/helpers.js";

/**
 * Express integration.
 *
 * `createHttpLogger` is `pino-http` wired to this package's serializers, so it
 * mounts as a plain Express middleware and logs every request through the
 * package logger. Like the Fastify suite, every assertion reads the emitted JSON
 * rather than trusting the configuration was accepted.
 *
 * Express does not attach `request.log` natively; `pino-http` adds it, so route
 * handlers can call `req.log.info(...)`. Express also parses `req.query`, which
 * the serializer copies through with sensitive keys masked.
 */

const SECRET = "s3cret-token-value";

/** Boots an Express server whose pino-http middleware writes to a memory sink. */
function boot() {
    const { stream, records } = collector();

    const app = express();
    app.use(createHttpLogger({ logger: createLogger({ mode: "production", destination: stream }) }));

    app.get("/hello", (req, res) => {
        req.log.info({ password: "s3cret-route-password" }, "handling hello");
        res.json({ message: "hello" });
    });

    const server = http.createServer(app);
    return { server, records, stream };
}

/** Fails loudly, with context, when an expected log line was not emitted. */
function require<T>(value: T | undefined, context: string): T {
    if (value === undefined) {
        throw new Error(`missing expected log record: ${context}`);
    }

    return value;
}

/** Starts the given server, runs `run` against its port, then always closes it. */
async function withServer(server: http.Server, run: (port: number) => Promise<void>): Promise<void> {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
        await run(port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

/** Sends one request and waits for its response to end. */
function hit(port: number, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = http.request({ port, path }, (res) => {
            res.resume();
            res.on("end", () => setTimeout(resolve, 30));
        });
        req.on("error", reject);
        req.end();
    });
}

describe("Express integration: createHttpLogger middleware", () => {
    it("actually uses the package logger", async () => {
        const { server, records } = boot();

        await withServer(server, async (port) => {
            await hit(port, "/hello");

            expect(records.length, "Express emitted nothing through the package logger").toBeGreaterThan(0);
            for (const record of records) {
                expect(record.pid, "missing package base pid").toBe(process.pid);
                expect(typeof record.level, "level was not formatted by the package formatter").toBe("string");
            }
        });
    });

    it("redacts secrets logged through request.log", async () => {
        const { server, records } = boot();

        await withServer(server, async (port) => {
            await hit(port, "/hello");

            const routeLog = require(records.find((record) => record.msg === "handling hello"), "route log line");
            expect(routeLog.password).toBe("[REDACTED]");
            expect(JSON.stringify(records)).not.toContain("s3cret-route-password");
        });
    });

    it("strips the query string from Express's own request log", async () => {
        const { server, records } = boot();

        await withServer(server, async (port) => {
            await hit(port, `/hello?token=${SECRET}`);

            const incoming = require(
                records.find(
                    (record) => typeof record.req?.url === "string" && record.req.url.startsWith("/hello"),
                ),
                `request line; saw ${records.map((r) => r.msg).join(", ")}`,
            );
            expect(incoming.req.url).toBe("/hello");
            expect(JSON.stringify(records), "token leaked through Express request logging").not.toContain(SECRET);
        });
    });

    it("masks sensitive keys in the parsed query while keeping harmless ones", async () => {
        const { server, records } = boot();

        await withServer(server, async (port) => {
            await hit(port, `/hello?token=${SECRET}&page=2&foo=bar`);

            const incoming = require(records.find((record) => record.req?.query !== undefined), "request line with a parsed query");

            expect(incoming.req.query.token).toBe("[REDACTED]");
            expect(incoming.req.query.page).toBe("2");
            expect(incoming.req.query.foo).toBe("bar");
        });
    });

    it("emits an ISO timestamp from the package configuration", async () => {
        const { server, records } = boot();

        await withServer(server, async (port) => {
            await hit(port, "/hello");

            const stamp = records[0].time;
            expect(typeof stamp, "no time field").toBe("string");
            expect(stamp, `not ISO-8601: ${stamp}`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });
    });
});
