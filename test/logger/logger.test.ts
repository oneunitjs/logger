import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";

import { createLogger, createChildLogger } from "../../src/logger/logger.js";
import { defineConfig, redactBindings } from "../../src/logger/config.js";
import { createSerializers } from "../../src/http/serializers.js";
import { createTransport, createMultiTransport } from "../../src/transport/transport.js";
import { createHttpLogger } from "../../src/http/middleware.js";

/**
 * pino types `redact` as `string[] | redactOptions`, but `defineConfig`
 * always returns the object form. Narrow once here so assertions can read
 * `.paths` without a cast at every call site.
 */
function redactPaths(config: pino.LoggerOptions): readonly string[] {
    const { redact } = config;

    if (!redact || Array.isArray(redact)) {
        throw new Error("expected an object-form redact config");
    }

    return redact.paths as readonly string[];
}

describe("logger", () => {
    it("should create a logger with default options", () => {
        const logger = createLogger();
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(typeof logger.error).toBe("function");
        expect(typeof logger.warn).toBe("function");
        expect(typeof logger.debug).toBe("function");
        expect(typeof logger.trace).toBe("function");
    });

    it("should create a logger with development mode", () => {
        const logger = createLogger({ mode: "development" });
        expect(logger).toBeDefined();
    });

    it("should create a logger with production mode", () => {
        const logger = createLogger({ mode: "production" });
        expect(logger).toBeDefined();
    });

    it("should create a logger with test mode", () => {
        const logger = createLogger({ mode: "test" });
        expect(logger).toBeDefined();
    });

    it("should create a child logger with bindings", () => {
        const logger = createLogger();
        const child = createChildLogger(logger, { requestId: "123", userId: "456" });
        expect(child).toBeDefined();
        expect(child.bindings().requestId).toBe("123");
        expect(child.bindings().userId).toBe("456");
    });

    it("should create logger with custom serializers", () => {
        const logger = createLogger({ serializers: { excludeHeaders: true } });
        expect(logger).toBeDefined();
    });

    it("should preserve child bindings in emitted output", () => {
        const { logger, records } = createCapturingLogger();
        logger.child({ requestId: "abc-123" }).info("hi");
        expect(records()![0]!.requestId).toBe("abc-123");
    });

    it("should apply explicit pino overrides", () => {
        const { logger, records } = createCapturingLogger({ pino: { level: "warn" } });
        logger.info("should be dropped");
        logger.warn("kept");
        const out = records();
        expect(out).toHaveLength(1);
        expect(out[0]!.msg).toBe("kept");
    });

    it("should not throw when creating a child with no bindings", () => {
        const logger = createLogger();
        expect(() => createChildLogger(logger, {})).not.toThrow();
        expect(() => createChildLogger(logger)).not.toThrow();
        expect(createChildLogger(logger, {})).toBe(logger);
    });

    it("should not throw for empty childBindings", () => {
        expect(() => createLogger({ childBindings: {} })).not.toThrow();
    });
});

describe("defineConfig", () => {
    it("should return default config for development", () => {
        const config = defineConfig({ mode: "development" });
        expect(config.level).toBe("trace");
        expect(config.base).toBeDefined();
        expect(config.timestamp).toBeDefined();
    });

    it("should return production config with redaction", () => {
        const config = defineConfig({ mode: "production" });
        expect(config.level).toBe("info");
        expect(config.redact).toBeDefined();
        expect(redactPaths(config)).toContain("req.headers.authorization");
        // Deeply nested keys are handled by the log formatter rather than by
        // an explicit path list; see `redactLogObject`.
        expect(config.formatters?.log).toBeTypeOf("function");
    });

    it("should return silent config for test", () => {
        const config = defineConfig({ mode: "test" });
        expect(config.level).toBe("silent");
    });

    it("should redact secrets in every mode, not only production", () => {
        for (const mode of ["production", "development", "test"] as const) {
            const config = defineConfig({ mode });
            expect(config.redact, `mode=${mode}`).toBeDefined();
        }
    });

    it("should not include the unsupported bindings formatter", () => {
        const config = defineConfig({ mode: "production" });
        expect((config.formatters as Record<string, unknown>).bindings).toBeUndefined();
        expect(config.formatters?.level).toBeTypeOf("function");
    });

    it("should not share a mutable redact path list between configs", () => {
        const a = defineConfig({ mode: "production" });
        const b = defineConfig({ mode: "production" });

        expect(redactPaths(a)).not.toBe(redactPaths(b));
        expect(Object.isFrozen(redactPaths(a))).toBe(true);
    });

    it("should keep redact path count small", () => {
        const config = defineConfig({ mode: "production" });
        // A large path list is compiled into per-path matchers and dominates
        // serialization cost; deep coverage comes from the formatter instead.
        expect(redactPaths(config).length).toBeLessThanOrEqual(32);
    });

    it("should not mutate the caller's object when redacting", () => {
        const shared = { user: { name: "alice", password: "hunter2" } };
        const config = defineConfig({ mode: "production" });

        config.formatters!.log!({ shared } as never);

        expect(shared.user.password).toBe("hunter2");
    });

    it("should redact deeply nested secrets without a depth limit", () => {
        const config = defineConfig({ mode: "production" });
        const deep: Record<string, any> = {};
        let cursor = deep;
        for (let i = 0; i < 12; i++) {
            cursor.next = {};
            cursor = cursor.next;
        }
        cursor.password = "buried";

        const result = config.formatters!.log!({ deep } as never) as Record<string, any>;
        let node = result.deep;
        for (let i = 0; i < 12; i++) {
            node = node.next;
        }

        expect(node.password).toBe("[REDACTED]");
    });

    it("should redact sensitive keys inside arrays", () => {
        const config = defineConfig({ mode: "production" });
        const result = config.formatters!.log!({
            users: [{ name: "a", password: "p1" }],
        } as never) as Record<string, any>;

        expect(result.users[0].password).toBe("[REDACTED]");
        expect(result.users[0].name).toBe("a");
    });

    it("should tolerate circular references when redacting", () => {
        const config = defineConfig({ mode: "production" });
        const circular: Record<string, any> = { password: "p" };
        circular.self = circular;

        const result = config.formatters!.log!({ circular } as never) as Record<string, any>;
        expect(result.circular.password).toBe("[REDACTED]");
    });

    it("should redact res headers produced by serializers", () => {
        const records = captureWithConfig(defineConfig({ mode: "production" }), {
            res: { headers: { "set-cookie": "sid=SECRET" } },
        });
        expect(records[0]!.res.headers["set-cookie"]).toBe("[REDACTED]");
    });

    it("should not throw when a payload getter throws", () => {
        const config = defineConfig({ mode: "production" });
        const hostile = {
            get bad() {
                throw new Error("boom");
            },
            password: "p",
        };

        // pino tolerates unserializable payloads; redaction must not be stricter.
        expect(() => config.formatters!.log!({ hostile } as never)).not.toThrow();
    });

    it("should preserve toJSON output while redacting it", () => {
        const config = defineConfig({ mode: "production" });

        class Dto {
            password = "topsecret";

            toJSON() {
                return { password: "topsecret", note: "from toJSON" };
            }
        }

        const result = config.formatters!.log!({ d: new Dto() } as never) as Record<string, any>;

        // Dropping toJSON would silently drop fields the logger used to emit.
        expect(result.d.note).toBe("from toJSON");
        expect(result.d.password).toBe("[REDACTED]");
    });

    it("should redact an own toJSON on a plain object", () => {
        const config = defineConfig({ mode: "production" });
        const payload = {
            other: 1,
            toJSON() {
                return { password: "leak" };
            },
        };

        const result = config.formatters!.log!({ payload } as never) as Record<string, any>;

        expect(result.payload.password).toBe("[REDACTED]");
    });

    it("should keep Date and Buffer output identical to plain pino", () => {
        const config = defineConfig({ mode: "production" });
        const result = config.formatters!.log!({
            when: new Date(0),
            buf: Buffer.from("hi"),
        } as never) as Record<string, any>;

        expect(result.when).toBe(new Date(0).toISOString());
        expect(JSON.stringify(result.buf)).toBe(JSON.stringify({ type: "Buffer", data: [104, 105] }));
    });

    it("should redact every sibling key when several are sensitive", () => {
        // Regression: re-copying the source per key used to restore earlier values.
        const config = defineConfig({ mode: "production" });
        const result = config.formatters!.log!({
            password: "a",
            token: "b",
            secret: "c",
            keep: "d",
        } as never) as Record<string, any>;

        expect(result.password).toBe("[REDACTED]");
        expect(result.token).toBe("[REDACTED]");
        expect(result.secret).toBe("[REDACTED]");
        expect(result.keep).toBe("d");
    });

    it("should not mutate sibling objects when one key is redacted", () => {
        const config = defineConfig({ mode: "production" });
        const child = { name: "alice" };
        const payload = { child, password: "p" };

        const result = config.formatters!.log!(payload as never) as Record<string, any>;

        expect(result.child).toBe(child);
        expect(payload.password).toBe("p");
    });

    it("should not let a pino override drop the redaction formatter", () => {
        const hijack = (object: Record<string, unknown>) => ({ ...object, hijacked: true });

        const logger = createLogger({
            mode: "development",
            // `formatters` is excluded from the public type; a JavaScript
            // caller can still pass one.
            pino: { formatters: { log: hijack } } as never,
        });

        const symbol = Object.getOwnPropertySymbols(logger)
            .find((candidate) => String(candidate).includes("formatters"));
        const formatters = (logger as unknown as Record<symbol, any>)[symbol!];

        expect(formatters.log).not.toBe(hijack);
        expect(formatters.log).toBeTypeOf("function");
    });

    it("should still honour a level override", () => {
        const logger = createLogger({ mode: "development", pino: { level: "warn" } });
        expect(logger.level).toBe("warn");
    });

    it("should not let a toJSON that returns itself bypass redaction", () => {
        // `toJSON` returning the receiver used to hand back the unredacted
        // original via the cycle guard.
        const config = defineConfig({ mode: "production" });

        class SelfJson {
            password = "LEAKED";

            toJSON() {
                return this;
            }
        }

        const result = config.formatters!.log!({ u: new SelfJson() } as never) as Record<string, any>;

        expect(JSON.stringify(result)).not.toContain("LEAKED");
        expect(result.u.password).toBe("[REDACTED]");
    });

    it("should not throw on an object with a throwing ownKeys trap", () => {
        const config = defineConfig({ mode: "production" });
        const hostile = new Proxy({} as Record<string, unknown>, {
            ownKeys() {
                throw new Error("proxy-boom");
            },
        });

        expect(() => config.formatters!.log!({ hostile } as never)).not.toThrow();
    });

    it("should survive extreme nesting without a stack overflow", () => {
        const config = defineConfig({ mode: "production" });
        const root: Record<string, any> = {};
        let cursor = root;
        for (let i = 0; i < 50_000; i++) {
            cursor.next = {};
            cursor = cursor.next;
        }

        expect(() => config.formatters!.log!({ root } as never)).not.toThrow();
    });

    it("should redact sensitive child bindings created via logger.child", () => {
        const logger = createLogger({ mode: "production" });

        expect(logger.child({ apiKey: "secret", requestId: "r1" }).bindings())
            .toEqual({ apiKey: "[REDACTED]", requestId: "r1" });
    });

    it("should redact sensitive childBindings at logger creation", () => {
        const logger = createLogger({
            mode: "production",
            childBindings: { secret: "s", tenantId: "t9" },
        });

        expect(logger.bindings()).toEqual({ secret: "[REDACTED]", tenantId: "t9" });
    });

    it("should redact bindings for createChildLogger", () => {
        const logger = createLogger({ mode: "production" });
        const child = createChildLogger(logger, { password: "p", userId: "u1" });

        expect(child.bindings()).toEqual({ password: "[REDACTED]", userId: "u1" });
    });

    it("should keep inherited bindings when nesting children", () => {
        const logger = createLogger({ mode: "production" });
        const nested = logger.child({ requestId: "n" }).child({ apiKey: "k" }).child({ token: "t" });

        // Regression guard: wrapping `child` must not re-root the instance and
        // drop bindings inherited from ancestors.
        expect(nested.bindings()).toEqual({
            requestId: "n",
            apiKey: "[REDACTED]",
            token: "[REDACTED]",
        });
    });

    it("should not mutate the caller's bindings object", () => {
        const logger = createLogger({ mode: "production" });
        const bindings = { apiKey: "secret" };

        logger.child(bindings);

        expect(bindings.apiKey).toBe("secret");
    });

    it("should not walk live objects bound as values", () => {
        // pino-http binds the raw request for every request; walking its
        // socket graph cost ~27us per call and duplicated pino's redact paths.
        class Live {
            password = "should-be-untouched";

            header = { nested: { deeply: { value: 1 } } };
        }

        const live = new Live();
        const bindings = { req: live };

        expect(redactBindings(bindings).req).toBe(live);
    });

    it("should still redact plain objects nested in bindings", () => {
        const bindings = redactBindings({
            apiKey: "k",
            requestId: "r",
            user: { id: 1, password: "p" },
            tags: [{ token: "t" }],
        });

        expect(bindings).toEqual({
            apiKey: "[REDACTED]",
            requestId: "r",
            user: { id: 1, password: "[REDACTED]" },
            tags: [{ token: "[REDACTED]" }],
        });
    });

    it("should keep the redaction formatter when child options are passed", () => {
        // pino-http calls `logger.child({}, opts)`; options must not drop the
        // redaction formatter the way a `formatters` override would.
        const logger = createLogger({ mode: "production" });
        const child = logger.child({ requestId: "r" }, { serializers: {} });

        const symbol = Object.getOwnPropertySymbols(child)
            .find((candidate) => String(candidate).includes("formatters"));
        const formatters = (child as unknown as Record<symbol, any>)[symbol!];

        expect(formatters.log).toBeTypeOf("function");
    });

    it("should redact top-level sensitive keys", () => {
        const records = captureWithConfig(defineConfig({ mode: "production" }), {
            password: "p",
            token: "t",
            secret: "s",
            accessToken: "a",
            refreshToken: "r",
            apiKey: "k",
        });

        expect(records[0]!.password).toBe("[REDACTED]");
        expect(records[0]!.token).toBe("[REDACTED]");
        expect(records[0]!.secret).toBe("[REDACTED]");
        expect(records[0]!.accessToken).toBe("[REDACTED]");
        expect(records[0]!.refreshToken).toBe("[REDACTED]");
        expect(records[0]!.apiKey).toBe("[REDACTED]");
    });

    it("should redact nested sensitive keys at multiple depths", () => {
        const records = captureWithConfig(defineConfig({ mode: "production" }), {
            user: { password: "d1" },
            a: { b: { token: "d2" } },
        });

        expect(records[0]!.user.password).toBe("[REDACTED]");
        expect(records[0]!.a.b.token).toBe("[REDACTED]");
    });

    it("should redact authorization and cookie headers", () => {
        const records = captureWithConfig(defineConfig({ mode: "production" }), {
            req: { headers: { authorization: "Bearer S", cookie: "c=1" } },
            res: { headers: { "set-cookie": "sid=SECRET" } },
        });

        expect(records[0]!.req.headers.authorization).toBe("[REDACTED]");
        expect(records[0]!.req.headers.cookie).toBe("[REDACTED]");
        expect(records[0]!.res.headers["set-cookie"]).toBe("[REDACTED]");
    });

    it("should redact sensitive query parameters", () => {
        const records = captureWithConfig(defineConfig({ mode: "production" }), {
            req: { query: { token: "leak", page: "1" } },
        });

        expect(records[0]!.req.query.token).toBe("[REDACTED]");
        expect(records[0]!.req.query.page).toBe("1");
    });
});

describe("createSerializers", () => {
    it("should create custom serializers", () => {
        const serializers = createSerializers();
        expect(serializers.err).toBeDefined();
        expect(serializers.req).toBeDefined();
        expect(serializers.res).toBeDefined();
    });

    it("should exclude headers when option is set", () => {
        const serializers = createSerializers({ excludeHeaders: true });
        const mockReq = {
            method: "GET",
            url: "/test",
            host: "localhost",
            hostname: "localhost",
            headers: { "x-custom": "value" },
            remoteAddress: "127.0.0.1",
            remotePort: 1234,
            protocol: "http",
            queryString: "",
        };
        const result = serializers.req(mockReq);
        expect(result.headers).toBeUndefined();
    });

    it("should exclude query when option is set", () => {
        const serializers = createSerializers({ excludeQuery: true });
        const mockReq = {
            method: "GET",
            url: "/test?foo=bar",
            host: "localhost",
            hostname: "localhost",
            headers: {},
            remoteAddress: "127.0.0.1",
            remotePort: 1234,
            protocol: "http",
            queryString: "foo=bar",
        };
        const result = serializers.req(mockReq);
        expect(result.query).toBeUndefined();
    });

    it("should honor excludeHeaders for responses", () => {
        const serializers = createSerializers({ excludeHeaders: true });
        const result = serializers.res({
            statusCode: 200,
            headers: { "set-cookie": "sid=SECRET" },
        });
        expect(result.headers).toBeUndefined();
        expect(result.statusCode).toBe(200);
    });

    it("should omit empty query rather than emitting an empty string", () => {
        const serializers = createSerializers();
        const result = serializers.req({ method: "GET", url: "/plain", headers: {} });
        expect(result.query).toBeUndefined();
    });

    it("should fall back to the host header when host is absent", () => {
        const serializers = createSerializers();
        const result = serializers.req({
            method: "GET",
            url: "/x",
            headers: { host: "api.example.com" },
        });
        expect(result.host).toBe("api.example.com");
    });

    it("should derive remotePort from the socket", () => {
        const serializers = createSerializers();
        const result = serializers.req({
            method: "GET",
            url: "/x",
            headers: {},
            socket: { remoteAddress: "10.0.0.5", remotePort: 5555 },
        });
        expect(result.remoteAddress).toBe("10.0.0.5");
        expect(result.remotePort).toBe(5555);
    });

    it("should strip the query string from the url when requested", () => {
        const serializers = createSerializers({ excludeQueryString: true });
        const result = serializers.req({
            method: "GET",
            url: "/x?token=leak",
            headers: {},
        });
        expect(result.url).toBe("/x");
        expect(result.queryString).toBeUndefined();
    });

    it("should keep the url and query string when explicitly enabled", () => {
        const serializers = createSerializers({ excludeQueryString: false });
        const result = serializers.req({
            method: "GET",
            url: "/x?token=leak",
            headers: {},
        });
        expect(result.url).toBe("/x?token=leak");
        expect(result.queryString).toBe("token=leak");
    });

    it("should strip the query string by default", () => {
        // A query string is a common place for tokens; the `query` string is
        // stripped from the URL while the parsed `query` object is still emitted,
        // with sensitive keys masked so nothing secret reaches the sink.
        const serializers = createSerializers();
        const result = serializers.req({
            method: "GET",
            url: "/x?token=leak",
            query: { token: "leak", page: "1" },
            headers: {},
        });

        expect(result.url).toBe("/x");
        expect(result.queryString).toBeUndefined();
        expect(result.query).toEqual({ token: "[REDACTED]", page: "1" });
    });

    it("should use the first value of a repeated host header", () => {
        const serializers = createSerializers();
        const result = serializers.req({
            method: "GET",
            url: "/x",
            headers: { host: ["a.example.com", "b.example.com"] },
        });
        expect(result.host).toBe("a.example.com");
    });

    it("should omit statusCode rather than emitting null", () => {
        const serializers = createSerializers();
        const result = serializers.res({ headers: { a: "b" } });
        expect(result.statusCode).toBeUndefined();
        expect("statusCode" in result).toBe(false);
    });

    it("should read headers from a real ServerResponse", async () => {
        // `res.headers` is undefined on a raw Node response; the std
        // serializer resolves them via getHeaders().
        const srv = http.createServer((req, res) => {
            res.setHeader("x-custom", "visible");
            expect(createSerializers().res(res as never).headers).toEqual({ "x-custom": "visible" });
            res.end("ok");
        });

        await new Promise<void>((resolve) => srv.listen(0, resolve));
        const { port } = srv.address() as AddressInfo;
        await new Promise<void>((resolve, reject) => {
            const req = http.request({ port, path: "/" }, (res) => {
                res.resume();
                res.on("end", () => setTimeout(resolve, 50));
            });
            req.on("error", reject);
            req.end();
        });
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    it("should not emit empty response headers", () => {
        const serializers = createSerializers();
        const result = serializers.res({ statusCode: 200 });
        expect(result.headers).toBeUndefined();
    });

    it("should keep the Express originalUrl", () => {
        const serializers = createSerializers({ excludeQueryString: false });
        const result = serializers.req({
            method: "GET",
            originalUrl: "/full/orig?token=leak",
            url: "/mounted",
            headers: {},
        } as never);

        expect(result.url).toBe("/full/orig?token=leak");
    });

    it("should resolve a hapi-style url object to a string", () => {
        const serializers = createSerializers({ excludeQueryString: false });
        const result = serializers.req({
            method: "GET",
            url: { path: "/hapi/path?a=1" },
            headers: {},
        } as never);

        // Emitting the url object verbatim would nest it in the log line.
        expect(result.url).toBe("/hapi/path?a=1");
    });

    it("should strip the query string from framework-resolved urls", () => {
        const serializers = createSerializers({ excludeQueryString: true });
        const result = serializers.req({
            method: "GET",
            originalUrl: "/full/orig?token=leak",
            url: "/mounted",
            headers: {},
        } as never);

        expect(result.url).toBe("/full/orig");
        expect(result.queryString).toBeUndefined();
    });
});

describe("createTransport", () => {
    it("should create pretty transport", () => {
        const transport = createTransport({ target: "pretty" });
        expect(transport).toBeDefined();
        expect("targets" in transport).toBe(true);
    });

    it("should create file transport", () => {
        const transport = createTransport({ target: "file", destination: "/tmp/test.log" });
        expect(transport).toBeDefined();
        expect("targets" in transport).toBe(true);
    });

    it("should throw for file transport without destination", () => {
        expect(() => createTransport({ target: "file" })).toThrow("File transport requires a destination path");
    });

    it("should create stream transport", () => {
        const stream = process.stdout;
        const transport = createTransport({ target: "stream", destination: stream });
        expect(transport).toBeDefined();
        expect("targets" in transport).toBe(true);
    });

    it("should throw for stream transport without destination", () => {
        expect(() => createTransport({ target: "stream" })).toThrow("Stream transport requires a writable stream");
    });

    it("should throw for unknown target", () => {
        expect(() => createTransport({ target: "unknown" as any })).toThrow("Unknown transport target");
    });

    it("should reject a non-writable object as a stream destination", () => {
        expect(() => createTransport({ target: "stream", destination: {} as any }))
            .toThrow("Stream transport requires a writable stream");
    });

    it("should honor destination for the pretty target", () => {
        const transport = createTransport({ target: "pretty", destination: "/tmp/pretty.log" });
        const options = (transport.targets[0] as any).options as Record<string, unknown>;
        expect(options.destination).toBe("/tmp/pretty.log");
    });

    it("should honor a stream destination for the pretty target", () => {
        const stream = new Writable({ write(_c, _e, cb) { cb(); } });
        const transport = createTransport({ target: "pretty", destination: stream });
        const options = (transport.targets[0] as any).options as Record<string, unknown>;
        expect(options.destination).toBe(stream);
    });

    it("should honor an explicit level", () => {
        const transport = createTransport({ target: "pretty", level: "warn" });
        expect((transport.targets[0] as any).level).toBe("warn");
    });
});

describe("createMultiTransport", () => {
    it("should create multi transport", () => {
        const transport = createMultiTransport([
            { target: "pretty", level: "info" },
            { target: "file", destination: "/tmp/test.log", level: "debug" },
        ]);
        expect(transport).toBeDefined();
        expect(transport.targets).toHaveLength(2);
        expect((transport.targets[0] as any).level).toBe("info");
        expect((transport.targets[1] as any).level).toBe("debug");
    });

    it("should preserve per-target destinations", () => {
        const transport = createMultiTransport([
            { target: "pretty", destination: "/tmp/a.log", level: "info" },
            { target: "file", destination: "/tmp/b.log", level: "debug" },
        ]);
        const first = (transport.targets[0] as any).options as Record<string, unknown>;
        const second = (transport.targets[1] as any).options as Record<string, unknown>;
        expect(first.destination).toBe("/tmp/a.log");
        expect(second.destination).toBe("/tmp/b.log");
    });

    it("should throw for an empty transport list", () => {
        expect(() => createMultiTransport([])).toThrow("at least one transport");
    });
});

describe("createHttpLogger", () => {
    it("should create http logger middleware", () => {
        const middleware = createHttpLogger();
        expect(middleware).toBeDefined();
        expect(typeof middleware).toBe("function");
    });

    it("should create http logger with custom options", () => {
        const middleware = createHttpLogger({ loggerOptions: { mode: "development" } });
        expect(middleware).toBeDefined();
    });

    it("should use a supplied logger instance", () => {
        const provided = pino({ level: "silent" });
        const middleware = createHttpLogger({ logger: provided });
        const used = (middleware as unknown as { logger: pino.Logger }).logger;

        expect(used).toBeDefined();
        // pino-http wraps the logger in a child, so assert the configured
        // level is inherited rather than comparing identity.
        expect(used.level).toBe(provided.level);
    });

    it("should redact the query string from logged urls by default", () => {
        const serializers = createSerializers({ excludeQueryString: true });
        const result = serializers.req({
            method: "GET",
            url: "/api/x?token=leak",
            headers: {},
        });
        expect(result.url).toBe("/api/x");
    });

    it("should never emit secrets from a real request end-to-end", async () => {
        const records: Array<Record<string, any>> = [];
        const dest = new Writable({
            write(chunk, _enc, cb) {
                records.push(JSON.parse(chunk.toString()));
                cb();
            },
        });

        const mw = createHttpLogger({
            logger: pino({ ...defineConfig({ mode: "production" }), serializers: createSerializers({ excludeQueryString: true }) }, dest),
        });

        const srv = http.createServer((req, res) => {
            mw(req, res);
            res.end("ok");
        });

        await new Promise<void>((resolve) => srv.listen(0, resolve));
        const { port } = srv.address() as AddressInfo;

        await new Promise<void>((resolve, reject) => {
            const req = http.request({
                port,
                path: "/api/x?token=leak&password=hunter2",
                headers: { authorization: "Bearer SECRET", cookie: "sid=1" },
            }, (res) => {
                res.resume();
                res.on("end", () => setTimeout(resolve, 50));
            });
            req.on("error", reject);
            req.end();
        });

        await new Promise<void>((resolve) => srv.close(() => resolve()));

        const line = records[0]!;
        expect(line).toBeDefined();

        const serialized = JSON.stringify(line);
        expect(serialized).not.toContain("leak");
        expect(serialized).not.toContain("hunter2");
        expect(serialized).not.toContain("SECRET");
        expect(line.req.url).toBe("/api/x");
        expect(line.req.headers.authorization).toBe("[REDACTED]");
    });
});

/**
 * Captures real log output by pointing a logger at an in-memory stream.
 * `createLogger` writes to stdout, so the stream is injected via the pino
 * escape hatch to observe what actually reaches a sink.
 */
function createCapturingLogger(options?: Parameters<typeof createLogger>[0]) {
    const records: Array<Record<string, any>> = [];
    const dest = new Writable({
        write(chunk, _enc, cb) {
            records.push(JSON.parse(chunk.toString()));
            cb();
        },
    });

    const config = defineConfig({ mode: options?.mode ?? "production" });
    const logger = pino({ ...config, ...options?.pino, serializers: createSerializers(options?.serializers) }, dest);

    return { logger, records: () => records };
}

function captureWithConfig(config: pino.LoggerOptions, payload: Record<string, unknown>) {
    const records: Array<Record<string, any>> = [];
    const dest = new Writable({
        write(chunk, _enc, cb) {
            records.push(JSON.parse(chunk.toString()));
            cb();
        },
    });

    pino({ ...config, level: config.level === "silent" ? "info" : config.level as string }, dest).info(payload, "m");

    return records;
}
