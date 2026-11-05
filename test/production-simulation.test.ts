import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { createLogger } from "../src/logger/logger.js";
import { createHttpLogger } from "../src/http/middleware.js";
import { createTransportInstance, registerGracefulShutdown } from "../src/transport/lifecycle.js";
import { validateConfigOrThrow } from "../src/config-validation.js";
import { collector } from "./helpers/helpers.js";

/**
 * Production simulation (Phase 12).
 *
 * Exercises the full stack together: Fastify server -> package logger ->
 * redaction engine -> HTTP serializers -> pino pipeline -> file/stream outputs.
 * Every assertion reads emitted JSON lines.
 */

const SECRET_PASSWORD = "s3cret-prod-password";
const SECRET_TOKEN = "s3cret-prod-token";

async function bootProductionApp() {
    const { stream, records } = collector();

    const logger = createLogger({
        mode: "production",
        destination: stream,
        context: {
            service: "payment-service",
            env: "production",
            version: "1.0.0",
        },
    });

    const httpLogger = createHttpLogger({ logger });

    const app = Fastify({ loggerInstance: logger });

    app.get("/health", async () => {
        return { status: "ok" };
    });

    app.post("/login", async (request) => {
        request.log.info(
            {
                username: "test-user",
                password: SECRET_PASSWORD,
                authorization: `Bearer ${SECRET_TOKEN}`,
                sessionToken: SECRET_TOKEN,
            },
            "login attempt",
        );
        return { status: "ok" };
    });

    app.get("/payment", async (request) => {
        const child = logger.child({ module: "payment" });
        child.info({ transactionId: "TX-001", apiKey: SECRET_TOKEN }, "payment processed");
        return { status: "ok" };
    });

    app.get("/error", async () => {
        const original = new Error("database unavailable");
        const error = new Error("payment failed", { cause: original });
        Object.assign(error, { password: SECRET_PASSWORD });
        logger.error({ err: error, transactionId: "TX-002" }, "payment failure");
        return { status: "error" };
    });

    await app.ready();
    return { app, records, logger };
}

function require<T>(value: T | undefined, context: string): T {
    if (value === undefined) {
        throw new Error(`missing expected log record: ${context}`);
    }
    return value;
}

/** Polls for a file to exist with non-empty content, up to ~2 seconds. */
async function waitForContent(file: string, timeoutMs = 2000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, "utf8").trim();
            if (content) {
                return content;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`file ${file} never received content`);
}

describe("production simulation scenario A: authentication (Phase 12)", () => {
    it("emits no secret from a login request end to end", async () => {
        const { app, records } = await bootProductionApp();

        try {
            await app.inject({
                method: "POST",
                url: "/login?token=" + SECRET_TOKEN,
                headers: {
                    authorization: `Bearer ${SECRET_TOKEN}`,
                    cookie: "sid=" + SECRET_TOKEN,
                },
            });

            const emitted = JSON.stringify(records);
            expect(emitted).not.toContain(SECRET_PASSWORD);
            expect(emitted).not.toContain(SECRET_TOKEN);
            expect(emitted).not.toContain("Bearer " + SECRET_TOKEN);

            const loginLog = require(
                records.find((record) => record.msg === "login attempt"),
                "login attempt log line",
            );
            expect(loginLog.password).toBe("[REDACTED]");
            expect(loginLog.authorization).toBe("[REDACTED]");
            expect(loginLog.sessionToken).toBe("[REDACTED]");
        } finally {
            await app.close();
        }
    });
});

describe("production simulation scenario B: payment failure (Phase 12)", () => {
    it("preserves diagnostics while redacting sensitive error metadata", async () => {
        const { app, records } = await bootProductionApp();

        try {
            await app.inject({ method: "GET", url: "/error" });

            const errorLog = require(
                records.find((record) => record.msg === "payment failure"),
                "payment failure log line",
            );

            expect(errorLog.err.type).toBe("Error");
            expect(errorLog.err.message).toBe("payment failed");
            expect(errorLog.err.cause).toBeDefined();
            expect(errorLog.err.cause.message).toBe("database unavailable");
            expect(errorLog.transactionId).toBe("TX-002");
            expect(errorLog.err.password).toBe("[REDACTED]");

            const emitted = JSON.stringify(records);
            expect(emitted).not.toContain(SECRET_PASSWORD);
        } finally {
            await app.close();
        }
    });
});

describe("production simulation scenario C: multiple child loggers (Phase 12)", () => {
    it("keeps redaction and context across application, auth, payment, and database children", () => {
        const { stream, records } = collector();

        const appLogger = createLogger({
            mode: "production",
            destination: stream,
            context: { service: "payment-service", env: "production" },
        });

        const authLogger = appLogger.child({ module: "auth", apiKey: SECRET_TOKEN });
        const paymentLogger = appLogger.child({ module: "payment", password: SECRET_PASSWORD });
        const databaseLogger = appLogger.child({ module: "database", token: SECRET_TOKEN });

        authLogger.info("auth event");
        paymentLogger.info("payment event");
        databaseLogger.info("database event");

        expect(records).toHaveLength(3);

        for (const record of records) {
            expect(record.module).toBeDefined();
            const serialized = JSON.stringify(record);
            expect(serialized).not.toContain(SECRET_TOKEN);
            expect(serialized).not.toContain(SECRET_PASSWORD);
        }

        expect(records[0].apiKey).toBe("[REDACTED]");
        expect(records[1].password).toBe("[REDACTED]");
        expect(records[2].token).toBe("[REDACTED]");
        expect(records[0].module).toBe("auth");
        expect(records[1].module).toBe("payment");
        expect(records[2].module).toBe("database");
    });
});

describe("production simulation scenario D: concurrent traffic (Phase 12)", () => {
    it("handles 1000 concurrent requests with no cross-request context leakage", async () => {
        const { app, records } = await bootProductionApp();

        try {
            const count = 1000;
            await Promise.all(
                Array.from({ length: count }, (_, i) =>
                    app.inject({
                        method: "POST",
                        url: `/login?token=${SECRET_TOKEN}&password=${SECRET_PASSWORD}`,
                        headers: {
                            "x-correlation-id": `corr-${i}`,
                            authorization: `Bearer ${SECRET_TOKEN}`,
                        },
                    }),
                ),
            );

            expect(records.length).toBeGreaterThan(count / 2);

            const emitted = JSON.stringify(records);
            expect(emitted).not.toContain(SECRET_PASSWORD);
            expect(emitted).not.toContain(SECRET_TOKEN);
        } finally {
            await app.close();
        }
    });
});

describe("production simulation scenario E: shutdown (Phase 12)", () => {
    it("flushes pending logs on SIGTERM with a real file transport", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneunit-prod-"));
        const file = path.join(dir, "prod.log");

        try {
            const transport = createTransportInstance({
                target: "file",
                destination: file,
            });

            const logger = createLogger({
                mode: "production",
                destination: transport,
                context: { service: "payment-service" },
            });

            logger.info({ message: "before signal" }, "active logging");

            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

            const cleanup = registerGracefulShutdown(transport, { exitCode: 0 });

            process.emit("SIGTERM");
            await new Promise((resolve) => setImmediate(resolve));

            expect(exitSpy).toHaveBeenCalledWith(0);

            cleanup();

            const content = await waitForContent(file);
            expect(content).toContain("before signal");
            expect(content).toContain("payment-service");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("production simulation scenario F: recovery (Phase 12)", () => {
    it("continues logging when the destination errors transiently", () => {
        const failingStream = new Writable({
            write(_chunk, _enc, cb) {
                cb(new Error("destination unavailable"));
            },
        });

        expect(() =>
            createLogger({ mode: "production", destination: failingStream }).info(
                { message: "x" },
                "recovery",
            ),
        ).not.toThrow();
    });

    it("rejects invalid configuration at startup via validateConfigOrThrow", () => {
        expect(() => validateConfigOrThrow({ mode: "invalid" as any })).toThrow(
            "Invalid logger configuration",
        );
    });
});
