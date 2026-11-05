import { describe, it, expect } from "vitest";

import { createSerializers } from "../../src/http/serializers.js";
import { createLogger } from "../../src/logger/logger.js";
import { collector, REDACTED } from "../helpers/helpers.js";

const SECRET = "s3cret-value";

/**
 * Header allowlist and authorization normalization (TC-038, TC-039, TC-040).
 */

describe("header allowlist (TC-038)", () => {
    it("passes only allowlisted headers and redacts the rest", () => {
        const result = createSerializers({
            headerAllowlist: ["content-type", "user-agent"],
        }).req({
            method: "GET",
            url: "/x",
            headers: {
                "content-type": "application/json",
                "user-agent": "test-agent",
                authorization: `Bearer ${SECRET}`,
                cookie: "sid=secret",
                "x-api-key": SECRET,
            },
        });

        const headers = result.headers as Record<string, string>;
        expect(headers["content-type"]).toBe("application/json");
        expect(headers["user-agent"]).toBe("test-agent");
        expect(headers["authorization"]).toBe("[REDACTED]");
        expect(headers["cookie"]).toBe("[REDACTED]");
        expect(headers["x-api-key"]).toBe("[REDACTED]");
    });

    it("matches allowlisted headers case-insensitively", () => {
        const result = createSerializers({
            headerAllowlist: ["Content-Type"],
        }).req({
            method: "GET",
            url: "/x",
            headers: {
                "CONTENT-TYPE": "application/json",
                authorization: `Bearer ${SECRET}`,
            },
        });

        const headers = result.headers as Record<string, string>;
        expect(headers["CONTENT-TYPE"]).toBe("application/json");
        expect(headers["authorization"]).toBe("[REDACTED]");
    });

    it("handles missing and empty headers", () => {
        const result = createSerializers({
            headerAllowlist: ["content-type"],
        }).req({
            method: "GET",
            url: "/x",
            headers: {},
        });

        expect(result.headers).toEqual({});
    });
});

describe("authorization normalization (TC-039)", () => {
    it.each([
        ["Authorization", `Bearer ${SECRET}`],
        ["authorization", `Basic ${SECRET}`],
        ["AUTHORIZATION", SECRET],
    ])("redacts the %s header regardless of casing", (headerName, headerValue) => {
        const result = createSerializers({ normalizeAuth: true }).req({
            method: "GET",
            url: "/x",
            headers: { [headerName]: headerValue, "user-agent": "keep" },
        });

        const headers = result.headers as Record<string, string>;
        expect(headers[headerName]).toBe("[REDACTED]");
        expect(headers["user-agent"]).toBe("keep");
        expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("does not redact authorization when normalizeAuth is false", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/x",
            headers: { authorization: `Bearer ${SECRET}` },
        });

        const headers = result.headers as Record<string, string>;
        expect(headers["authorization"]).toBe(`Bearer ${SECRET}`);
    });
});

describe("query exclusion options (TC-040)", () => {
    it("excludeQueryString removes url query and omits queryString", () => {
        const result = createSerializers({ excludeQueryString: true }).req({
            method: "GET",
            url: "/x?token=secret",
            headers: {},
        });

        expect(result.url).toBe("/x");
        expect(result.queryString).toBeUndefined();
    });

    it("excludeHeaders omits headers entirely", () => {
        const result = createSerializers({ excludeHeaders: true }).req({
            method: "GET",
            url: "/x",
            headers: { authorization: `Bearer ${SECRET}` },
        });

        expect("headers" in result).toBe(false);
    });

    it("excludeQuery omits the parsed query object", () => {
        const result = createSerializers({ excludeQuery: true }).req({
            method: "GET",
            url: "/x",
            query: { token: SECRET, page: "1" },
            headers: {},
        });

        expect("query" in result).toBe(false);
    });
});
