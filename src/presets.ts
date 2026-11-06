import type { LoggerMode, LoggerOptions, RedactionConfig } from "./types.js";
import { validateConfigOrThrow } from "./config-validation.js";

/**
 * Environment-based logger presets.
 *
 * Presets provide sensible defaults for common environments while remaining
 * fully overridable. They are convenience functions, not restrictions.
 */
export const presets = {
    /**
     * Production preset: level `info`, structured JSON, redaction active,
     * hostname/pid in base.
     */
    production(options: {
        service?: string | undefined;
        version?: string | undefined;
        redaction?: RedactionConfig | undefined;
    } = {}) {
        return {
            mode: "production" as const,
            context: {
                service: options.service,
                env: "production",
                version: options.version,
            },
            redaction: {
                headerAllowlist: ["content-type", "content-length", "user-agent"],
                normalizeAuth: true,
                ...options.redaction,
            },
        };
    },

    /**
     * Development preset: level `trace`, redaction active, verbose output.
     */
    development(options: {
        service?: string | undefined;
        version?: string | undefined;
        redaction?: RedactionConfig | undefined;
    } = {}) {
        return {
            mode: "development" as const,
            context: {
                service: options.service,
                env: "development",
                version: options.version,
            },
            redaction: options.redaction,
        };
    },

    /**
     * Test preset: level `silent`, redaction active, minimal output.
     */
    test(options: {
        service?: string | undefined;
        version?: string | undefined;
        redaction?: RedactionConfig | undefined;
    } = {}) {
        return {
            mode: "test" as const,
            context: {
                service: options.service,
                env: "test",
                version: options.version,
            },
            redaction: options.redaction,
        };
    },

    /**
     * CI preset: level `silent`, redaction active, audit enabled, strict
     * header allowlisting. Designed for CI/CD log sinks.
     */
    ci(options: {
        service?: string | undefined;
        version?: string | undefined;
        redaction?: RedactionConfig | undefined;
    } = {}) {
        return {
            mode: "test" as const,
            context: {
                service: options.service,
                env: "ci",
                version: options.version,
            },
            redaction: {
                headerAllowlist: ["content-type"],
                normalizeAuth: true,
                audit: {
                    enabled: true,
                    eventLevel: "warn",
                },
                ...options.redaction,
            },
        };
    },
};

/**
 * Resolves a preset into full `createLogger` options, validating the result.
 *
 * Throws on invalid configuration.
 */
export function resolvePreset(
    presetName: "development" | "production" | "test" | "ci",
    options: {
        service?: string | undefined;
        version?: string | undefined;
        level?: string | undefined;
        redaction?: RedactionConfig | undefined;
        destination?: NodeJS.WritableStream;
    } = {},
): LoggerOptions {
    const base = presets[presetName]({
        service: options.service,
        version: options.version,
        redaction: options.redaction,
    });

    const config = {
        ...base,
        level: options.level,
        destination: options.destination,
    };

    validateConfigOrThrow({
        mode: config.mode,
        redaction: config.redaction as RedactionConfig | undefined,
    });

    return config as LoggerOptions;
}

/**
 * Creates a logger from an environment preset with validation.
 *
 * Example:
 *   const logger = createLoggerFromPreset("production", {
 *       service: "payment-service",
 *       version: "1.2.0",
 *   });
 */
export async function createLoggerFromPreset(
    presetName: "development" | "production" | "test" | "ci",
    options: {
        service?: string | undefined;
        version?: string | undefined;
        level?: string | undefined;
        redaction?: RedactionConfig | undefined;
        destination?: NodeJS.WritableStream;
    } = {},
): Promise<ReturnType<typeof import("./logger/logger.js").createLogger>> {
    const { createLogger } = await import("./logger/logger.js");
    const config = resolvePreset(presetName, options);
    return createLogger(config);
}
