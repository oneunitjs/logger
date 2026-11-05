import { describe, it, expect } from "vitest";

import { createSerializers } from "../../src/http/serializers.js";
import { createLogger } from "../../src/logger/logger.js";
import { collector, REDACTED } from "../helpers/helpers.js";

/**
 * Serializer-level tests.
 *
 * Two kinds of assertion appear here and the difference matters:
 *
 *  - Direct assertions on `createSerializers()` output, which pin the
 *    documented shape of each field.
 *  - Assertions on *emitted* log lines, which are the only ones that prove
 *    anything about security. A serializer can return a perfectly redacted
 *    object that never reaches the sink, or the sink can leak through a field
 *    the serializer never touched.
 *
 * Redaction happens in `formatters.log`, which pino runs *before* serializers
 * and which then feeds the serializer, so masking is observed in the emitted
 * line for values the serializer copies through.
 */

const SECRET = "s3cret-value";

/**
 * Reads the `headers` field off a serialized request/response.
 *
 * The serializers return a loose record, so the field is re-typed here rather
 * than casting at each assertion.
 */
function headersOf(result: Record<string, any>): Record<string, string> {
    return (result.headers ?? {}) as Record<string, string>;
}

describe("req serializer: core fields", () => {
    it("emits method, url, host, and protocol", () => {
        const result = createSerializers().req({
            method: "POST",
            url: "/orders",
            headers: { host: "api.test" },
            protocol: "https",
        });

        expect(result.method).toBe("POST");
        expect(result.url).toBe("/orders");
        expect(result.host).toBe("api.test");
        expect(result.protocol).toBe("https");
    });

    it("prefers explicit host over the host header", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/",
            host: "explicit.test",
            headers: { host: "header.test" },
        });

        expect(result.host).toBe("explicit.test");
    });

    it("falls back to the host header when host is absent", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/",
            headers: { host: "header.test" },
        });

        expect(result.host).toBe("header.test");
    });

    it("uses the first value of a repeated host header", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/",
            headers: { host: ["first.test", "second.test"] },
        });

        expect(result.host).toBe("first.test");
    });

    it("surfaces the correlation id header", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/",
            headers: { "x-correlation-id": "corr-1" },
        });

        expect(result.correlationId).toBe("corr-1");
    });

    it("derives remote address and port from the socket", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/",
            headers: {},
            socket: { remoteAddress: "10.0.0.1", remotePort: 51234 },
        });

        expect(result.remoteAddress).toBe("10.0.0.1");
        expect(result.remotePort).toBe(51234);
    });

    it("keeps the user agent header", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/",
            headers: { "user-agent": "test-agent/1.0" },
        });

        expect(headersOf(result)["user-agent"]).toBe("test-agent/1.0");
    });
});

describe("req serializer: url edge cases", () => {
    it("strips the query string by default", () => {
        const result = createSerializers().req({ method: "GET", url: "/x?token=abc" });

        expect(result.url).toBe("/x");
    });

    it("keeps a url that has no query string", () => {
        const result = createSerializers().req({ method: "GET", url: "/plain" });

        expect(result.url).toBe("/plain");
    });

    it("returns undefined for a missing url", () => {
        const result = createSerializers().req({ method: "GET" });

        expect(result.url).toBeUndefined();
    });

    it("handles an empty url without throwing", () => {
        const result = createSerializers().req({ method: "GET", url: "" });

        expect(result.url).toBe("");
    });

    it("treats a url of only a query string as an empty path", () => {
        const result = createSerializers().req({ method: "GET", url: "?token=abc" });

        expect(result.url).toBe("");
    });

    it("strips an encoded query string without decoding it into the path", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/search?q=a%20b&token=abc",
        });

        expect(result.url).toBe("/search");
    });

    it("keeps an encoded path intact", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/a%20b/c?x=1",
        });

        expect(result.url).toBe("/a%20b/c");
    });

    it("handles duplicate query parameters", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/x?tag=a&tag=b&token=abc",
        });

        expect(result.url).toBe("/x");
    });

    it("handles empty query parameters", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/x?token=&other=",
        });

        expect(result.url).toBe("/x");
    });

    it("handles a bare question mark", () => {
        const result = createSerializers().req({ method: "GET", url: "/x?" });

        expect(result.url).toBe("/x");
    });

    it("keeps the query string when explicitly enabled", () => {
        const result = createSerializers({ excludeQueryString: false }).req({
            method: "GET",
            url: "/x?token=abc",
        });

        expect(result.url).toBe("/x?token=abc");
        expect(result.queryString).toBe("token=abc");
    });
});

describe("query object: masking and preservation", () => {
    it("emits a framework-supplied query object", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/x",
            query: { page: "2" },
        });

        expect(result.query).toEqual({ page: "2" });
    });

    it("omits query entirely when it would be empty", () => {
        const result = createSerializers().req({
            method: "GET",
            url: "/x",
            query: {},
        });

        expect("query" in result).toBe(false);
    });

    it("omits query when excludeQuery is set", () => {
        const result = createSerializers({ excludeQuery: true }).req({
            method: "GET",
            url: "/x",
            query: { page: "2" },
        });

        expect("query" in result).toBe(false);
    });

    it.each([
        ["token", SECRET],
        ["Token", SECRET],
        ["TOKEN", SECRET],
        ["apiKey", SECRET],
        ["apikey", SECRET],
        ["APIKEY", SECRET],
        ["password", SECRET],
        ["clientSecret", SECRET],
        ["privateKey", SECRET],
    ])("masks the sensitive query key %s in emitted output", (key, value) => {
        const { stream, records } = collector();

        createLogger({ mode: "production", destination: stream }).info({
            req: { method: "GET", url: "/x", headers: {}, query: { [key]: value, page: "2" } },
        }, "query casing");

        const req = records[0].req;
        expect(req.query[key], `${key} was not masked`).toBe(REDACTED);
        expect(req.query.page, "harmless parameter was lost").toBe("2");
        expect(JSON.stringify(records)).not.toContain(SECRET);
    });
});

describe("header redaction: emitted output", () => {
    it.each([
        "authorization",
        "Authorization",
        "AUTHORIZATION",
        "cookie",
        "Cookie",
        "set-cookie",
        "Set-Cookie",
        "x-api-key",
        "X-Api-Key",
    ])("masks the %s header in emitted output", (header) => {
        const { stream, records } = collector();

        createLogger({ mode: "production", destination: stream }).info({
            req: { method: "GET", url: "/x", headers: { [header]: SECRET, "user-agent": "keep-me" } },
        }, "header casing");

        expect(records[0].req.headers[header], `${header} was not masked`).toBe(REDACTED);
        expect(records[0].req.headers["user-agent"], "harmless header was lost").toBe("keep-me");
    });

    it.each(["proxy-authorization", "Proxy-Authorization"])(
        "masks the %s header in emitted output",
        (header) => {
            const { stream, records } = collector();

            createLogger({ mode: "production", destination: stream }).info({
                req: { method: "GET", url: "/x", headers: { [header]: SECRET, "user-agent": "keep-me" } },
            }, "proxy auth");

            expect(records[0].req.headers[header], `${header} was not masked`).toBe(REDACTED);
            expect(records[0].req.headers["user-agent"], "harmless header was lost").toBe("keep-me");
        },
    );

    it("masks sensitive response headers in emitted output", () => {
        const { stream, records } = collector();

        createLogger({ mode: "production", destination: stream }).info({
            res: { statusCode: 200, headers: { "set-cookie": SECRET, "content-type": "application/json" } },
        }, "response headers");

        expect(records[0].res.headers["set-cookie"]).toBe(REDACTED);
        expect(records[0].res.headers["content-type"]).toBe("application/json");
    });

    it("omits headers entirely when excludeHeaders is set", () => {
        const result = createSerializers({ excludeHeaders: true }).req({
            method: "GET",
            url: "/x",
            headers: { authorization: SECRET },
        });

        expect("headers" in result).toBe(false);
    });
});

describe("res serializer", () => {
    it("emits the status code", () => {
        const result = createSerializers().res({ statusCode: 201 });

        expect(result.statusCode).toBe(201);
    });

    it("omits a null status code rather than emitting it", () => {
        const result = createSerializers().res({});

        expect("statusCode" in result).toBe(false);
    });

    it("emits headers when present", () => {
        const result = createSerializers().res({
            statusCode: 200,
            headers: { "content-type": "text/plain" },
        });

        expect(headersOf(result)["content-type"]).toBe("text/plain");
    });

    it("omits empty headers", () => {
        const result = createSerializers().res({ statusCode: 200, headers: {} });

        expect("headers" in result).toBe(false);
    });

    it("omits headers when excludeHeaders is set", () => {
        const result = createSerializers({ excludeHeaders: true }).res({
            statusCode: 200,
            headers: { "content-type": "text/plain" },
        });

        expect("headers" in result).toBe(false);
    });
});

describe("serializer robustness", () => {
    it("does not throw on a request with no headers", () => {
        expect(() => createSerializers().req({ method: "GET", url: "/x" })).not.toThrow();
    });

    it("does not throw on a response with no status code", () => {
        expect(() => createSerializers().res({})).not.toThrow();
    });

    it("does not throw on a non-string url", () => {
        expect(() => createSerializers().req({ method: "GET", url: 42 as never })).not.toThrow();
    });

    it("exposes the standard error serializer", () => {
        const result = createSerializers().err(new Error("boom")) as { message?: string };

        expect(result.message).toBe("boom");
    });
});
