import type { LoggerMode, RedactionConfig } from "./types.js";

/**
 * Validates a logger configuration and returns descriptive errors.
 *
 * Does not throw: callers can decide how to handle invalid config.
 */
export function validateConfig(options: {
    mode?: LoggerMode | undefined;
    redaction?: RedactionConfig | undefined;
}): {
    valid: boolean;
    errors: Array<{ field: string; message: string; suggestion?: string }>;
} {
    const errors: Array<{ field: string; message: string; suggestion?: string }> = [];
    const { mode, redaction } = options;

    if (mode !== undefined && !["development", "production", "test"].includes(mode)) {
        errors.push({
            field: "mode",
            message: `Invalid mode "${mode}". Expected one of: development, production, test.`,
            suggestion: 'Use mode: "production" for structured JSON output.',
        });
    }

    if (redaction) {
        if (redaction.maxDepth !== undefined) {
            if (typeof redaction.maxDepth !== "number" || !Number.isInteger(redaction.maxDepth)) {
                errors.push({
                    field: "redaction.maxDepth",
                    message: `maxDepth must be an integer, received ${typeof redaction.maxDepth}.`,
                    suggestion: "Use maxDepth: 100 for deep payloads, or a smaller value for performance.",
                });
            } else if (redaction.maxDepth < 1) {
                errors.push({
                    field: "redaction.maxDepth",
                    message: "maxDepth must be at least 1.",
                    suggestion: "Use maxDepth: 10 for shallow payloads, or 100 for deep nesting.",
                });
            } else if (redaction.maxDepth > 10000) {
                errors.push({
                    field: "redaction.maxDepth",
                    message: "maxDepth above 10000 risks stack overflow on deep payloads.",
                    suggestion: "Keep maxDepth at or below 1000 for safety.",
                });
            }
        }

        if (redaction.keys) {
            for (const key of redaction.keys) {
                if (typeof key !== "string" || key.length === 0) {
                    errors.push({
                        field: "redaction.keys",
                        message: "All custom sensitive keys must be non-empty strings.",
                        suggestion: "Remove empty or non-string entries from redaction.keys.",
                    });
                    break;
                }
            }
        }

        if (redaction.rules) {
            const rules = redaction.rules;
            for (let i = 0; i < rules.length; i++) {
                const rule = rules[i];
                if (!rule) {
                    continue;
                }
                if (!rule.keys && !rule.path && !rule.handler) {
                    errors.push({
                        field: `redaction.rules[${i}]`,
                        message: "Rule must specify at least one of: keys, path, or handler.",
                        suggestion: `Add keys: ["my-key"] or path: /\\.secret$/ to rule ${i}.`,
                    });
                }
                if (rule.path instanceof RegExp === false && rule.path !== undefined) {
                    errors.push({
                        field: `redaction.rules[${i}].path`,
                        message: "rule.path must be a RegExp instance.",
                        suggestion: "Use path: /\\.token$/ for pattern matching.",
                    });
                }
            }
        }

        if (redaction.headerAllowlist) {
            for (const header of redaction.headerAllowlist) {
                if (typeof header !== "string" || header.length === 0) {
                    errors.push({
                        field: "redaction.headerAllowlist",
                        message: "All header allowlist entries must be non-empty strings.",
                        suggestion: "Use headerAllowlist: [\"content-type\", \"user-agent\"].",
                    });
                    break;
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validates configuration and throws on the first error.
 *
 * Use this at application startup to catch misconfiguration early.
 */
export function validateConfigOrThrow(options: {
    mode?: LoggerMode | undefined;
    redaction?: RedactionConfig | undefined;
}): void {
    const result = validateConfig(options);

    if (!result.valid) {
        const messages = result.errors
            .map((e) => {
                const suggestion = e.suggestion ? ` ${e.suggestion}` : "";
                return `  - ${e.field}: ${e.message}${suggestion}`;
            })
            .join("\n");

        throw new Error(`Invalid logger configuration:\n${messages}`);
    }
}
