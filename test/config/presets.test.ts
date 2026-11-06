import { describe, it, expect } from "vitest";

import { createLogger } from "../../src/logger/logger.js";
import { defineConfig } from "../../src/logger/config.js";
import { presets, resolvePreset } from "../../src/presets.js";
import { collector } from "../helpers/helpers.js";

/**
 * Environment presets (TC-058 through TC-062).
 */

describe("production preset (TC-058)", () => {
    it("sets level info, header allowlist, and auth normalization", () => {
        const config = presets.production({ service: "payment-service", version: "1.0.0" });

        expect(config.mode).toBe("production");
        expect(config.context!.service).toBe("payment-service");
        expect(config.context!.env).toBe("production");
        expect(config.context!.version).toBe("1.0.0");
        expect(config.redaction!.headerAllowlist).toEqual([
            "content-type",
            "content-length",
            "user-agent",
        ]);
        expect(config.redaction!.normalizeAuth).toBe(true);
    });

    it("creates a production logger emitting info-level JSON", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            redaction: presets.production().redaction!,
        });

        logger.info({ message: "started" }, "started");

        expect(records[0]!.level).toBe("info");
        expect(records[0]!.message).toBe("started");
        expect(records[0]!.msg).toBe("started");
    });
});

describe("development preset (TC-059)", () => {
    it("sets trace-level logging with redaction active", () => {
        const config = presets.development({ service: "dev-service" });

        expect(config.mode).toBe("development");
        expect(config.context!.env).toBe("development");
        // The preset supplies mode/context; defineConfig adds redaction.
        const resolved = defineConfig(config);
        expect(resolved.redact).toBeDefined();
    });

    it("redacts secrets even in development mode", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "development",
            pino: { level: "trace" },
            destination: stream,
            redaction: presets.development().redaction!,
        });

        logger.trace({ password: "DEV_SECRET" }, "dev");

        expect(records[0]!.password).toBe("[REDACTED]");
    });
});

describe("test preset (TC-060)", () => {
    it("sets silent logging with redaction active", () => {
        const config = presets.test({ service: "test-service" });

        expect(config.mode).toBe("test");
        expect(config.context!.env).toBe("test");
        const resolved = defineConfig(config);
        expect(resolved.level).toBe("silent");
        expect(resolved.redact).toBeDefined();
    });

    it("emits nothing by default in test mode", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "test",
            destination: stream,
            redaction: presets.test().redaction!,
        });

        logger.info({ password: "TEST_SECRET" }, "test");

        expect(records.length).toBe(0);
    });
});

describe("CI preset (TC-061)", () => {
    it("enables audit with warn level and strict content-type allowlist", () => {
        const config = presets.ci({ service: "ci-service" });

        expect(config.mode).toBe("test");
        expect(config.context!.env).toBe("ci");
        expect(config.redaction!.audit).toEqual({ enabled: true, eventLevel: "warn" });
        expect(config.redaction!.headerAllowlist).toEqual(["content-type"]);
        expect(config.redaction!.normalizeAuth).toBe(true);
    });
});

describe("preset overrides (TC-062)", () => {
    it("lets custom options override preset defaults", () => {
        const config = resolvePreset("production", {
            service: "svc",
            level: "debug",
            redaction: { headerAllowlist: ["content-type"] },
        });

        expect(config.mode).toBe("production");
        expect(config.level).toBe("debug");
        expect(config.redaction!.headerAllowlist).toEqual(["content-type"]);
    });

    it("rejects invalid preset configuration via resolvePreset", () => {
        expect(() =>
            resolvePreset("production", {
                redaction: { maxDepth: 0 as any },
            }),
        ).toThrow("Invalid logger configuration");
    });
});
