import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";

import { createLogger } from "../../src/logger/logger.js";
import { defineConfig } from "../../src/logger/config.js";
import { collector } from "../helpers/helpers.js";
import { presets } from "../../src/presets.js";
import type { LoggerOptions } from "../../src/types.js";

/**
 * Audit mode (TC-034, TC-035, TC-036).
 *
 * Audit events must never contain the original secret value, and the CI preset
 * must enable audit with warn-level events while keeping output silent.
 */

function auditSink(): { events: Array<Record<string, unknown>>; sink: Writable } {
    const events: Array<Record<string, unknown>> = [];
    const sink = new Writable({
        write(chunk, _enc, cb) {
            const text = chunk.toString().trim();
            if (text) {
                events.push(JSON.parse(text));
            }
            cb();
        },
    });
    return { events, sink };
}

describe("audit event creation (TC-034)", () => {
    it("emits a redaction audit event without the secret", () => {
        const { events, sink } = auditSink();
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: {
                audit: { enabled: true, sink, eventLevel: "warn" },
            },
        });

        logger.info({ password: "SECRET_PASSWORD" }, "audited");

        expect(records[0]!.password).toBe("[REDACTED]");
        expect(events.length).toBeGreaterThan(0);

        const redactionEvent = events.find((e) => e.event === "redaction");
        expect(redactionEvent).toBeDefined();
        expect(redactionEvent!.key).toBe("password");
        expect(redactionEvent!.depth).toBe(0);
        expect(redactionEvent!.isBinding).toBe(false);
        expect(redactionEvent!.level).toBe("warn");
        expect(JSON.stringify(redactionEvent)).not.toContain("SECRET_PASSWORD");
        expect(redactionEvent!.timestamp).toBeDefined();
        expect(typeof redactionEvent!.timestamp).toBe("string");
    });

    it("records nested redaction events with the correct path and depth", () => {
        const { events, sink } = auditSink();
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: {
                audit: { enabled: true, sink },
            },
        });

        logger.info({ user: { account: { credentials: { password: "DEEP_SECRET" } } } }, "nested");

        const redactionEvents = events.filter((e) => e.event === "redaction");
        const deep = redactionEvents.find((e) => e.key === "password");
        expect(deep).toBeDefined();
        expect(deep!.path).toEqual(["user", "account", "credentials", "password"]);
        expect(deep!.depth).toBe(3);
    });

    it("distinguishes binding redaction events", () => {
        const { events, sink } = auditSink();
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: {
                audit: { enabled: true, sink },
            },
        });

        logger.child({ apiKey: "CHILD_SECRET" }).info("child");

        const bindingEvent = events.find((e) => e.event === "redaction" && e.isBinding === true);
        expect(bindingEvent).toBeDefined();
        expect(bindingEvent!.key).toBe("apiKey");
        expect(records[0]!.apiKey).toBe("[REDACTED]");
    });
});

describe("audit secret protection (TC-035)", () => {
    it("never includes the original secret in any audit event", () => {
        const { events, sink } = auditSink();
        const { stream, records } = collector();

        const secret = "SECRET_AUDIT_VALUE_999";

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: {
                audit: { enabled: true, sink },
                rules: [
                    {
                        keys: ["apiKey"],
                        handler: (value) => `hash(${String(value).length})`,
                    },
                ],
            },
        });

        logger.info({ password: secret, apiKey: secret }, "audit protection");

        const allAuditText = JSON.stringify(events);
        expect(allAuditText).not.toContain(secret);
        expect(records[0]!.password).toBe("[REDACTED]");
        expect(records[0]!.apiKey).toBe(`hash(${secret.length})`);
    });

    it("handles audit sink errors without aborting the log call", () => {
        const breakingSink = new Writable({
            write(_chunk, _enc, cb) {
                cb(new Error("sink down"));
            },
        });
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: {
                audit: { enabled: true, sink: breakingSink },
            },
        });

        expect(() => logger.info({ password: "SECRET" }, "sink error")).not.toThrow();
        expect(records[0]!.password).toBe("[REDACTED]");
    });
});

describe("CI audit preset (TC-036)", () => {
    it("enables audit, uses warn event level, and keeps output silent", () => {
        const config = presets.ci({ service: "ci-service" });

        expect(config.mode).toBe("test");
        expect(config.context!.env).toBe("ci");
        expect(config.redaction).toBeDefined();
        expect(config.redaction!.audit).toEqual({ enabled: true, eventLevel: "warn" });
        expect(config.redaction!.headerAllowlist).toEqual(["content-type"]);
        expect(config.redaction!.normalizeAuth).toBe(true);

        // defineConfig is what adds the redacting `redact` path list and
        // formatter; redaction remains active in CI.
        const resolved = defineConfig(config as LoggerOptions);
        expect(resolved.level).toBe("silent");
        expect(resolved.redact).toBeDefined();
    });

    it("creates a CI logger that stays silent by level but redacts when output occurs", () => {
        // Use a separate audit sink so audit events do not pollute the log records.
        const auditEvents: Array<Record<string, unknown>> = [];
        const auditSink = new Writable({
            write(chunk, _enc, cb) {
                const text = chunk.toString().trim();
                if (text) {
                    auditEvents.push(JSON.parse(text));
                }
                cb();
            },
        });
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "test",
            pino: { level: "info" },
            destination: stream,
            redaction: {
                audit: { enabled: true, sink: auditSink, eventLevel: "warn" },
            },
        });

        logger.info({ password: "SECRET_CI" }, "ci");

        expect(records.length).toBe(1);
        expect(records[0]!.password).toBe("[REDACTED]");
        expect(JSON.stringify(records)).not.toContain("SECRET_CI");
        expect(auditEvents.length).toBeGreaterThan(0);
    });
});
