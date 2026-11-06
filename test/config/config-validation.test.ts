import { describe, it, expect } from "vitest";

import { validateConfig, validateConfigOrThrow } from "../../src/config-validation.js";

describe("validateConfig: valid configurations", () => {
    it("accepts default options", () => {
        const result = validateConfig({});
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("accepts all valid modes", () => {
        for (const mode of ["development", "production", "test"] as const) {
            const result = validateConfig({ mode });
            expect(result.valid).toBe(true);
        }
    });

    it("accepts valid redaction config", () => {
        const result = validateConfig({
            redaction: {
                keys: ["customKey"],
                maxDepth: 50,
                replacement: "[MASKED]",
                headerAllowlist: ["content-type"],
                normalizeAuth: true,
            },
        });
        expect(result.valid).toBe(true);
    });
});

describe("validateConfig: invalid mode", () => {
    it("rejects invalid mode with suggestion", () => {
        const result = validateConfig({ mode: "staging" as any });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("mode");
        expect(result.errors[0]!.message).toContain("staging");
        expect(result.errors[0]!.suggestion).toBeDefined();
    });

    it("rejects empty string mode", () => {
        const result = validateConfig({ mode: "" as any });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("mode");
    });
});

describe("validateConfig: invalid maxDepth", () => {
    it("rejects non-integer maxDepth", () => {
        const result = validateConfig({
            redaction: { maxDepth: 3.14 as any },
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.maxDepth");
    });

    it("rejects maxDepth below 1", () => {
        const result = validateConfig({ redaction: { maxDepth: 0 } });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.maxDepth");
    });

    it("rejects maxDepth above 10000", () => {
        const result = validateConfig({ redaction: { maxDepth: 20000 } });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.maxDepth");
    });

    it("accepts boundary maxDepth values", () => {
        const result1 = validateConfig({ redaction: { maxDepth: 1 } });
        expect(result1.valid).toBe(true);

        const result2 = validateConfig({ redaction: { maxDepth: 10000 } });
        expect(result2.valid).toBe(true);
    });
});

describe("validateConfig: invalid custom keys", () => {
    it("rejects empty string keys", () => {
        const result = validateConfig({
            redaction: { keys: ["valid", "", "also-valid"] },
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.keys");
    });

    it("rejects non-string keys", () => {
        const result = validateConfig({
            redaction: { keys: [123 as any] },
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.keys");
    });
});

describe("validateConfig: invalid rules", () => {
    it("rejects rules with no keys, path, or handler", () => {
        const result = validateConfig({
            redaction: { rules: [{}] as any },
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.rules[0]");
    });

    it("rejects non-RegExp path", () => {
        const result = validateConfig({
            redaction: { rules: [{ path: "not-a-regex" as any }] },
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.rules[0].path");
    });

    it("accepts valid rules", () => {
        const result = validateConfig({
            redaction: {
                rules: [
                    { keys: ["myKey"] },
                    { path: /\.secret$/ },
                    { handler: () => "[MASKED]" },
                ],
            },
        });
        expect(result.valid).toBe(true);
    });
});

describe("validateConfig: invalid header allowlist", () => {
    it("rejects empty header names", () => {
        const result = validateConfig({
            redaction: { headerAllowlist: ["content-type", ""] },
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.field).toBe("redaction.headerAllowlist");
    });

    it("accepts valid header allowlist", () => {
        const result = validateConfig({
            redaction: { headerAllowlist: ["content-type", "user-agent"] },
        });
        expect(result.valid).toBe(true);
    });
});

describe("validateConfigOrThrow", () => {
    it("throws on invalid configuration", () => {
        expect(() =>
            validateConfigOrThrow({ mode: "invalid" as any }),
        ).toThrow("Invalid logger configuration");
    });

    it("does not throw on valid configuration", () => {
        expect(() => validateConfigOrThrow({})).not.toThrow();
        expect(() => validateConfigOrThrow({ mode: "production" })).not.toThrow();
    });

    it("includes field and message in error", () => {
        try {
            validateConfigOrThrow({
                redaction: { maxDepth: -1 },
            });
            expect.fail("should have thrown");
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toContain("redaction.maxDepth");
            expect(message).toContain("at least 1");
        }
    });
});
