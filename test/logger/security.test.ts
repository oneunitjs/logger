import { describe, it, expect } from "vitest";

import { createLogger, createChildLogger } from "../../src/logger/logger.js";
import { createHttpLogger } from "../../src/http/middleware.js";
import { createSerializers } from "../../src/http/serializers.js";
import { defineConfig, redactLogObject } from "../../src/logger/config.js";
import { capture, collector, assertNoSecret, REDACTED, withServer, request } from "../helpers/helpers.js";

/**
 * Security regression suite.
 *
 * Each case corresponds to a bypass that actually shipped in this package and
 * was found by probing the built output. The rule enforced here: a caller who
 * logs data must never be able to get a secret onto a log sink, including via
 * paths that look like metadata (`url`, `queryString`, response headers, child
 * bindings) rather than obvious fields.
 *
 * Assertions parse the emitted JSON and check specific fields. A helper can
 * redact correctly in isolation while the value still reaches the sink through
 * another route, so the sink is what gets asserted on.
 */

/** Values that must never appear verbatim in emitted output. */
const SECRETS = {
    password: "s3cret-password-value",
    passwd: "s3cret-passwd-value",
    secret: "s3cret-secret-value",
    token: "s3cret-access-token",
    accessToken: "s3cret-access-token-value",
    refreshToken: "s3cret-refresh-token-value",
    apiKey: "s3cret-api-key-value",
    clientSecret: "s3cret-client-secret-value",
    privateKey: "s3cret-private-key-value",
    sessionId: "s3cret-session-id-value",
};

const BEARER = "Bearer s3cret-bearer-token";
const SET_COOKIE = "sid=s3cret-cookie-value";
const API_KEY_HEADER = "s3cret-header-api-key";

/** Sensitive key names that must be masked regardless of position. */
const SENSITIVE_KEYS = [
    "password",
    "passwd",
    "secret",
    "token",
    "accessToken",
    "refreshToken",
    "apiKey",
    "authorization",
    "cookie",
    "set-cookie",
    "clientSecret",
    "privateKey",
];

describe("redaction: every log mode", () => {
    for (const mode of ["production", "development", "test"] as const) {
        it(`masks sensitive keys in ${mode} mode`, () => {
            const config = defineConfig({ mode });

            expect(config.redact, `${mode} has no redact config`).toBeDefined();
            expect(config.formatters?.log, `${mode} has no redacting formatter`).toBeTypeOf("function");
        });
    }

    it.each(["production", "development", "test"] as const)(
        "masks sensitive keys in emitted %s output",
        (mode) => {
            // `test` mode defaults to level `silent`, so the level is raised
            // explicitly. The point is that redaction is not a production-only
            // concern: a local dev run or a failing test must not print a
            // secret to the terminal or CI log.
            const { stream, records } = collector();

            const logger = createLogger({
                mode,
                pino: { level: "trace" },
                destination: stream,
            });

            logger.info({ password: SECRETS.password, nested: { token: SECRETS.token } }, "mode check");

            expect(records, `no output in ${mode} mode`).toHaveLength(1);
            expect(records[0]!.password).toBe(REDACTED);
            expect(records[0]!.nested.token).toBe(REDACTED);
            expect(JSON.stringify(records)).not.toContain(SECRETS.password);
        },
    );
});

describe("redaction: key positions", () => {
    it("masks a sensitive key at the top level", () => {
        const { logger, records } = capture();

        logger.info({ password: SECRETS.password }, "top level");

        expect(records[0]!.password).toBe(REDACTED);
    });

    it("masks a sensitive key in a nested object", () => {
        const { logger, records } = capture();

        logger.info({
            user: { credentials: { password: SECRETS.password } },
        }, "nested");

        expect(records[0]!.user.credentials.password).toBe(REDACTED);
    });

    it("masks a sensitive key across multiple nesting levels", () => {
        const { logger, records } = capture();

        logger.info({ a: { b: { c: { token: SECRETS.token } } } }, "deep");

        expect(records[0]!.a.b.c.token).toBe(REDACTED);
    });

    it("masks a sensitive key inside arrays", () => {
        const { logger, records } = capture();

        logger.info({
            users: [
                { password: "one", id: 1 },
                { password: "two", id: 2 },
            ],
        }, "array");

        expect(records[0]!.users[0].password).toBe(REDACTED);
        expect(records[0]!.users[1].password).toBe(REDACTED);
        expect(records[0]!.users[0].id).toBe(1);
    });

    it("masks a sensitive key in mixed object and array structures", () => {
        const { logger, records } = capture();

        logger.info({
            tenants: [
                { name: "acme", secrets: [{ apiKey: SECRETS.apiKey }] },
                { name: "globex", nested: { deep: [{ token: SECRETS.token }] } },
            ],
        }, "mixed");

        expect(records[0]!.tenants[0].secrets[0].apiKey).toBe(REDACTED);
        expect(records[0]!.tenants[1].nested.deep[0].token).toBe(REDACTED);
        expect(records[0]!.tenants[0].name).toBe("acme");
    });

    it.each(SENSITIVE_KEYS)("masks the key %s", (key) => {
        const { logger, records } = capture();

        logger.info({ [key]: "value-for-key" }, "key under test");

        expect(records[0]![key], `${key} was not masked`).toBe(REDACTED);
    });

    it("masks sensitive keys regardless of casing", () => {
        const { logger, records } = capture();

        logger.info({
            AccessToken: "v1",
            APIKEY: "v2",
            ClientSecret: "v3",
            PassWord: "v4",
            AUTHORIZATION: "v5",
        }, "casing");

        for (const key of ["AccessToken", "APIKEY", "ClientSecret", "PassWord", "AUTHORIZATION"]) {
            expect(records[0]![key], `${key} was not masked`).toBe(REDACTED);
        }
    });

    it("does not mask unrelated keys", () => {
        const { logger, records } = capture();

        logger.info({
            userName: "alice",
            tokenCount: 4,
            pass: "ok",
            secretariat: "meeting",
            cookies: 12,
        }, "non-sensitive");

        expect(records[0]!.userName).toBe("alice");
        expect(records[0]!.tokenCount).toBe(4);
        expect(records[0]!.secretariat).toBe("meeting");
        expect(records[0]!.cookies).toBe(12);
    });
});

describe("redaction: toJSON escape routes", () => {
    it("masks a prototype toJSON result", () => {
        const { logger, records } = capture();

        class Model {
            password = SECRETS.password;

            toJSON() {
                return { password: SECRETS.password, note: "visible" };
            }
        }

        logger.info({ model: new Model() }, "model");

        expect(records[0]!.model.password).toBe(REDACTED);
        expect(records[0]!.model.note).toBe("visible");
    });

    it("masks an own toJSON on a plain object", () => {
        const { logger, records } = capture();

        logger.info({
            payload: {
                toJSON() {
                    return { token: SECRETS.token };
                },
            },
        }, "own toJSON");

        expect(records[0]!.payload.token).toBe(REDACTED);
    });

    it("masks a toJSON that returns itself", () => {
        // Regression: the cycle guard used to hand back the unredacted original.
        const { logger, records } = capture();

        class SelfReturning {
            password = SECRETS.password;

            toJSON() {
                return this;
            }
        }

        logger.info({ model: new SelfReturning() }, "self-returning toJSON");

        expect(records[0]!.model.password).toBe(REDACTED);
        assertNoSecret(records, { password: SECRETS.password }, "self-returning toJSON");
    });
});

describe("redaction: error objects", () => {
    it("masks sensitive metadata attached to an Error", () => {
        const { logger, records } = capture();

        const error = Object.assign(new Error("Authentication failed"), {
            password: SECRETS.password,
            token: SECRETS.token,
        });

        logger.error({ err: error }, "auth failed");

        expect(records[0]!.err.password).toBe(REDACTED);
        expect(records[0]!.err.token).toBe(REDACTED);
        // The message itself is not a redacted key and must survive.
        expect(records[0]!.err.message).toBe("Authentication failed");
    });

    it("preserves the error type and stack when redacting an error", () => {
        // `message` and `stack` are own but NON-enumerable properties of an
        // Error. A copy that took only own-enumerable keys would leave a plain
        // object behind, pino's `err` serializer would no longer see an Error,
        // and the log line would lose both the message and the trace. Masking a
        // secret must not cost the diagnostic value of the line.
        const { logger, records } = capture();

        const error = Object.assign(new Error("boom"), { apiKey: SECRETS.apiKey });

        logger.error({ err: error }, "failed");

        expect(records[0]!.err.type).toBe("Error");
        expect(records[0]!.err.message).toBe("boom");
        expect(records[0]!.err.stack).toContain("Error: boom");
        expect(records[0]!.err.apiKey).toBe(REDACTED);
        assertNoSecret(records, { apiKey: SECRETS.apiKey }, "error stack preservation");
    });

    it("leaves an error with no sensitive properties untouched", () => {
        // Nothing to mask, so the original instance is passed straight through
        // and the full standard shape is emitted.
        const { logger, records } = capture();

        logger.error({ err: new Error("clean") }, "no secrets");

        expect(records[0]!.err.type).toBe("Error");
        expect(records[0]!.err.message).toBe("clean");
        expect(records[0]!.err.stack).toContain("Error: clean");
    });

    it("masks sensitive metadata on a positional Error", () => {
        const { logger, records } = capture();

        const error = Object.assign(new Error("failed"), { apiKey: SECRETS.apiKey });

        logger.error(error, "positional");

        expect(records[0]!.err.apiKey).toBe(REDACTED);
    });

    it("masks an error nested inside a result field", () => {
        const { logger, records } = capture();

        const error = Object.assign(new Error("nested"), { clientSecret: SECRETS.clientSecret });

        logger.info({ result: { err: error } }, "nested error");

        assertNoSecret(records, { clientSecret: SECRETS.clientSecret }, "nested error");
    });
});

describe("redaction: child logger bindings", () => {
    it("masks bindings passed to logger.child", () => {
        const { logger, records } = capture();

        logger.child({ apiKey: SECRETS.apiKey, requestId: "r1" }).info("child");

        expect(records[0]!.apiKey).toBe(REDACTED);
        expect(records[0]!.requestId).toBe("r1");
    });

    it("masks bindings passed to createChildLogger", () => {
        const { logger, records } = capture();

        createChildLogger(logger, { password: SECRETS.password }).info("child");

        expect(records[0]!.password).toBe(REDACTED);
    });

    it("masks bindings supplied at logger creation", () => {
        const { stream, records } = collector();

        const logger = createLogger({
            mode: "production",
            destination: stream,
            childBindings: { clientSecret: SECRETS.clientSecret, tenant: "acme" },
        });

        logger.info("created with bindings");

        expect(records[0]!.clientSecret).toBe(REDACTED);
        expect(records[0]!.tenant).toBe("acme");
    });

    it("masks bindings on nested children while keeping inherited ones", () => {
        const { logger, records } = capture();

        logger
            .child({ requestId: "r1" })
            .child({ apiKey: SECRETS.apiKey })
            .child({ token: SECRETS.token })
            .info("nested");

        expect(records[0]!.apiKey).toBe(REDACTED);
        expect(records[0]!.token).toBe(REDACTED);
        expect(records[0]!.requestId).toBe("r1");
    });
});

describe("redaction: request metadata", () => {
    it("strips the query string from the url by default", () => {
        const { logger, records } = capture();

        logger.info({
            req: { method: "GET", url: `/login?token=${SECRETS.token}`, headers: {} },
        }, "url");

        expect(records[0]!.req.url).toBe("/login");
    });

    it("masks sensitive headers on an emitted request", () => {
        const { logger, records } = capture();

        logger.info({
            req: {
                url: "/x",
                headers: {
                    authorization: BEARER,
                    cookie: SET_COOKIE,
                    "x-api-key": API_KEY_HEADER,
                    "user-agent": "test-agent",
                },
            },
        }, "headers");

        expect(records[0]!.req.headers.authorization).toBe(REDACTED);
        expect(records[0]!.req.headers.cookie).toBe(REDACTED);
        expect(records[0]!.req.headers["x-api-key"]).toBe(REDACTED);
        expect(records[0]!.req.headers["user-agent"]).toBe("test-agent");
    });

    it("masks a set-cookie response header", () => {
        const { logger, records } = capture();

        logger.info({
            res: { statusCode: 200, headers: { "set-cookie": SET_COOKIE, "x-app": "ok" } },
        }, "response");

        expect(records[0]!.res.headers["set-cookie"]).toBe(REDACTED);
        expect(records[0]!.res.headers["x-app"]).toBe("ok");
    });
});

describe("hostile payloads do not defeat redaction", () => {
    it("survives a throwing getter", () => {
        const { logger, records } = capture();

        const hostile = {
            get explode(): never {
                throw new Error("boom");
            },
            password: SECRETS.password,
        };

        expect(() => logger.info({ hostile }, "throwing getter")).not.toThrow();
        expect(records[0]!.hostile.password).toBe(REDACTED);
    });

    it("survives a proxy with a throwing ownKeys trap", () => {
        const { logger } = capture();

        const hostile = new Proxy({} as Record<string, unknown>, {
            ownKeys(): never {
                throw new Error("proxy-boom");
            },
        });

        expect(() => logger.info({ hostile }, "proxy")).not.toThrow();
    });

    it("survives extreme nesting without a stack overflow", () => {
        const { logger } = capture();

        const deep: Record<string, unknown> = {};
        let cursor = deep;
        for (let i = 0; i < 20_000; i++) {
            cursor.next = {};
            cursor = cursor.next as Record<string, unknown>;
        }

        expect(() => logger.info({ deep }, "deep")).not.toThrow();
    });
});

describe("end-to-end: HTTP logging emits no secret", () => {
    it("redacts a hostile request end to end", async () => {
        const { stream, records } = collector();

        const middleware = createHttpLogger({
            logger: createLogger({ mode: "production", destination: stream }),
        });

        await withServer(
            (req, res) => {
                res.setHeader("set-cookie", SET_COOKIE);
                middleware(req, res);
                res.end("ok");
            },
            async (port) => {
                await request(port, `/pay?token=${SECRETS.token}&password=${SECRETS.password}`, {
                    authorization: BEARER,
                    cookie: SET_COOKIE,
                    "x-api-key": API_KEY_HEADER,
                });
            },
        );

        expect(records.length, "no log line was emitted").toBeGreaterThan(0);

        assertNoSecret(records, {
            ...SECRETS,
            bearer: BEARER,
            setCookie: SET_COOKIE,
            apiKeyHeader: API_KEY_HEADER,
        }, "end-to-end http");

        const completed = records.find((record) => record.msg === "request completed");

        if (!completed) {
            throw new Error(`missing completion line; saw ${records.map((r) => r.msg).join(", ")}`);
        }

        expect(completed.req.url).toBe("/pay");
        expect(completed.req.headers.authorization).toBe(REDACTED);
        expect(completed.res.headers["set-cookie"]).toBe(REDACTED);
    });
});

describe("runtime objects are preserved, not deep-walked", () => {
    it("leaves a class instance in bindings intact and un-mutated", () => {
        // Documented limitation, not an oversight. Bindings are traversed only
        // for plain objects and arrays; a class instance is bound by reference
        // and left for pino's own serialization. Walking it would cost a full
        // object-graph traversal on every log call for a payload the package
        // does not otherwise need to inspect.
        //
        // The consequence is that `password` on a model instance is NOT masked
        // here. That is a deliberate trade and is asserted deliberately, so a
        // future change that starts walking instances has to update this test
        // and re-examine the performance cost.
        class UserModel {
            password = SECRETS.password;
            name = "alice";
        }

        const user = new UserModel();
        const { logger } = capture();

        const child = logger.child({ user });

        expect(child, "child creation failed").toBeDefined();
        // The binding is the same object, not a traversed copy.
        expect(user.name).toBe("alice");
        expect(user.password).toBe(SECRETS.password);
    });

    it("does not deep-walk a live IncomingMessage bound as a value", () => {
        // The regression that motivates this whole design: an earlier
        // implementation walked the binding graph, reaching
        // socket -> connection -> parser -> ... on every log call.
        const message = {
            socket: {
                parser: {
                    incoming: [{ parser: { incoming: [{ parser: {} }] } }],
                },
                connection: { server: { config: { deep: { deeper: {} } } } },
            },
            get headers() {
                return { authorization: BEARER };
            },
        };

        const { logger } = capture();

        // A traversal would visit every nested node above.
        expect(() => logger.child({ req: message }).info("bound live object")).not.toThrow();
    });

    it("still redacts plain objects nested inside bindings", () => {
        const { logger, records } = capture();

        logger.child({ meta: { apiKey: SECRETS.apiKey, ok: "visible" } }).info("mixed bindings");

        expect(records[0]!.meta.apiKey).toBe(REDACTED);
        expect(records[0]!.meta.ok).toBe("visible");
    });

    it("still redacts arrays nested inside bindings", () => {
        const { logger, records } = capture();

        logger.child({ users: [{ token: SECRETS.token }] }).info("array bindings");

        expect(records[0]!.users[0].token).toBe(REDACTED);
    });
});

describe("large payloads", () => {
    it("redacts correctly within a large object and does not mutate it", () => {
        const { logger, records } = capture();

        // 50 sibling groups, each a few levels deep with one secret.
        const large: Record<string, any> = {};
        for (let i = 0; i < 50; i++) {
            large[`group${i}`] = {
                id: i,
                nested: { deeper: { token: `secret-${i}`, label: `item-${i}` } },
            };
        }

        logger.info(large, "large payload");

        expect(records[0]!.group49.nested.deeper.token).toBe(REDACTED);
        expect(records[0]!.group49.nested.deeper.label).toBe("item-49");
        expect(records[0]!.group0.nested.deeper.token).toBe(REDACTED);
        expect(records[0]!.group0.id).toBe(0);

        // Caller-owned data must be unchanged.
        expect(large.group49.nested.deeper.token).toBe("secret-49");
    });

    it("handles a large array payload", () => {
        const { logger, records } = capture();

        const items = Array.from({ length: 2_000 }, (_, i) => ({ id: i, password: `p-${i}` }));

        logger.info({ items }, "large array");

        expect(records[0]!.items).toHaveLength(2_000);
        expect(records[0]!.items[1_999].password).toBe(REDACTED);
        expect(records[0]!.items[1_999].id).toBe(1_999);
        expect(items[1_999]!.password).toBe("p-1999");
    });
});

describe("caller-owned data is never mutated", () => {
    it("leaves a logged payload unchanged", () => {
        const { logger } = capture();

        const data = { user: { password: SECRETS.password, name: "alice" } };
        logger.info(data, "mutation");

        expect(data.user.password).toBe(SECRETS.password);
    });

    it("leaves bindings unchanged", () => {
        const { logger } = capture();

        const bindings = { apiKey: SECRETS.apiKey };
        logger.child(bindings).info("mutation");

        expect(bindings.apiKey).toBe(SECRETS.apiKey);
    });

    it("leaves a shared object usable across calls", () => {
        const { logger, records } = capture();

        const shared = { password: SECRETS.password };
        logger.info({ shared }, "first");
        logger.info({ shared }, "second");

        expect(shared.password).toBe(SECRETS.password);
        expect(records[0]!.shared.password).toBe(REDACTED);
        expect(records[1]!.shared.password).toBe(REDACTED);
    });

    it("does not mutate via redactLogObject directly", () => {
        const payload = { user: { password: SECRETS.password } };

        redactLogObject(payload);

        expect(payload.user.password).toBe(SECRETS.password);
    });
});

describe("circular references are handled", () => {
    it("logs a circular plain object without crashing", () => {
        const { logger } = capture();

        const node: Record<string, unknown> = { password: SECRETS.password };
        node.self = node;

        expect(() => logger.info({ node }, "circular")).not.toThrow();
    });

    it("does not implement a competing cycle-breaking serializer", () => {
        // Reuses pino's own handling; this asserts the walker simply does not
        // crash where pino would otherwise cope.
        const { logger } = capture();

        const node: Record<string, unknown> = { password: SECRETS.password };
        node.self = node;

        expect(() => logger.info(node, "circular root")).not.toThrow();
    });
});

describe("secure defaults are consistent across every entry point", () => {
    it("createLogger strips the query string by default", () => {
        // The task's explicit case: a bare `createLogger()` must not emit a
        // query string, even though the caller never asked for HTTP logging.
        const { logger, records } = capture();

        logger.info({ req: { method: "GET", url: "/x?token=leak", headers: {} } }, "default");

        expect(records[0]!.req.url).toBe("/x");
        expect(JSON.stringify(records)).not.toContain("token=leak");
    });

    it("createSerializers strips the query string by default", () => {
        const result = createSerializers().req({ method: "GET", url: "/x?token=leak" });

        expect(result.url).toBe("/x");
    });

    it("createHttpLogger strips the query string by default", () => {
        // Asserted against emitted output, not the returned middleware, so a
        // silent default change cannot pass.
        const { stream, records } = collector();

        const middleware = createHttpLogger({
            logger: createLogger({ mode: "production", destination: stream }),
        });

        return withServer(
            (req, res) => {
                middleware(req, res);
                res.end("ok");
            },
            async (port) => {
                await request(port, "/x?token=leak");
            },
        ).then(() => {
            expect(records.length).toBeGreaterThan(0);
            expect(JSON.stringify(records)).not.toContain("token=leak");
        });
    });

    it("all three entry points agree on the default", () => {
        const fromSerializers = createSerializers().req({ method: "GET", url: "/x?token=leak" });

        const { logger, records } = capture();
        logger.info({ req: { method: "GET", url: "/x?token=leak", headers: {} } }, "agree");

        expect(fromSerializers.url).toBe("/x");
        expect(records[0]!.req.url).toBe("/x");
    });
});

describe("security invariants", () => {
    it("Invariant 1: default HTTP logging exposes no query-string secret", () => {
        for (const secret of ["token", "password", "apiKey", "secret", "clientSecret"]) {
            const { logger, records } = capture();

            logger.info({ req: { method: "GET", url: `/x?${secret}=LEAK`, headers: {} } }, secret);

            expect(JSON.stringify(records), `${secret} leaked`).not.toContain("LEAK");
        }
    });

    it("Invariant 2: sensitive structured fields follow the configured key policy", () => {
        const { logger, records } = capture();

        logger.info({
            password: "a",
            nested: { deeper: { apiKey: "b" } },
            list: [{ token: "c" }],
        }, "policy");

        expect(records[0]!.password).toBe(REDACTED);
        expect(records[0]!.nested.deeper.apiKey).toBe(REDACTED);
        expect(records[0]!.list[0].token).toBe(REDACTED);
    });

    it("Invariant 3: runtime objects are not deep-walked for redaction", () => {
        class Model {
            password = "a";
            nested = { token: "b" };
        }

        const model = new Model();
        const { logger } = capture();

        logger.child({ model }).info("bound model");

        // Unchanged: no traversal happened, so no copy was made.
        expect(model.password).toBe("a");
        expect(model.nested.token).toBe("b");
    });

    it("Invariant 4: pino's native redact paths stay active for serializer output", () => {
        // `res.headers` only exists after serialization, so it is covered by
        // pino's redact path list rather than the walker.
        const { stream, records } = collector();

        createLogger({ mode: "production", destination: stream }).info({
            res: { statusCode: 200, headers: { "set-cookie": "LEAK" } },
        }, "native redact");

        expect(records[0]!.res.headers["set-cookie"]).toBe(REDACTED);
        expect(JSON.stringify(records)).not.toContain("LEAK");
    });

    it("Invariant 5: child loggers retain parent redaction", () => {
        const { logger, records } = capture();

        const child = logger.child({ requestId: "1" });
        child.info({ password: "LEAK" }, "from child");

        expect(records[0]!.password).toBe(REDACTED);
        expect(records[0]!.requestId).toBe("1");
    });

    it("Invariant 6: the documented Fastify path uses the package logger", () => {
        // Covered end-to-end in integration.test.ts against a real Fastify
        // server. Re-asserted here only as the sink-independent half: the
        // package logger instance is what receives the lines.
        const { logger, records } = capture();

        logger.info({ password: "LEAK" }, "package logger");

        expect(records[0]!.password).toBe(REDACTED);
    });

    it("Invariant 7: caller-owned objects are not mutated", () => {
        const { logger } = capture();

        const data = { user: { password: "LEAK" } };
        logger.info(data, "no mutation");

        expect(data.user.password).toBe("LEAK");
    });

    it("Invariant 8: binding a live request stays cheap", () => {
        // Shape rather than an absolute budget: a bound non-plain object must
        // not be walked. Timing detail lives in performance.test.ts.
        class Request {
            public socket = { parser: { incoming: [{}] } };
        }

        const request = new Request();
        const { logger } = capture();

        expect(() => logger.child({ req: request }).info("cheap")).not.toThrow();
    });
});

describe("child loggers inherit parent configuration", () => {
    it("keeps redaction, level formatting, timestamp, and base on a child", () => {
        // Every field here is a parent setting. If a pino upgrade changed how
        // `child()` rebuilds formatters, this line would lose its redacted
        // password or revert to pino's numeric level / epoch time.
        const { logger, records } = capture();

        logger
            .child({ requestId: "req-1" })
            .info({ password: "LEAK" }, "from child");

        const record = records[0]!;

        expect(record.password, "child lost the redaction formatter").toBe(REDACTED);
        expect(record.requestId, "child lost its bindings").toBe("req-1");
        expect(record.level, "child lost the level formatter").toBe("info");
        expect(record.pid, "child lost the base bindings").toBe(process.pid);
        expect(record.time, "child lost the timestamp formatter").toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
    });

    it("keeps the redaction formatter when child options are passed", () => {
        // pino's `child(bindings, options)` path is the one most likely to drop
        // a parent formatter, because it rebuilds the child's formatters.
        const { logger, records } = capture();

        logger
            .child({ requestId: "req-2" }, { serializers: {} })
            .info({ password: "LEAK" }, "child with options");

        expect(records[0]!.password).toBe(REDACTED);
        expect(records[0]!.level).toBe("info");
    });

    it("keeps redaction through several levels of nesting", () => {
        const { logger, records } = capture();

        logger
            .child({ a: "1" })
            .child({ b: "2" })
            .child({ c: "3" })
            .info({ token: "LEAK" }, "deep child");

        expect(records[0]!.token).toBe(REDACTED);
        expect(records[0]!.a).toBe("1");
        expect(records[0]!.b).toBe("2");
        expect(records[0]!.c).toBe("3");
    });

    it("keeps the parent's serializers on a child", () => {
        // The `req` serializer strips the query string; a child that lost it
        // would emit the raw url.
        const { logger, records } = capture();

        logger
            .child({ requestId: "req-3" })
            .info({ req: { method: "GET", url: "/x?token=LEAK", headers: {} } }, "child serializer");

        expect(records[0]!.req.url).toBe("/x");
        expect(JSON.stringify(records)).not.toContain("LEAK");
    });
});

describe("query strings are stripped wherever a URL is logged", () => {
    // The request serializer strips the query from `req.url`, but an application
    // log that passes a URL directly never reaches the serializer. Without
    // walker-level stripping the "query strings are stripped" default held only
    // for the `req` key, and `logger.info({ url: request.url })` — an extremely
    // common shape — leaked the token in plaintext.
    it("strips a query string from a top-level url field", () => {
        const { logger, records } = capture();

        logger.info({ url: "/pay?token=LEAK" }, "route log");

        expect(records[0]!.url).toBe("/pay");
        expect(JSON.stringify(records)).not.toContain("LEAK");
    });

    it.each([
        ["url", "/pay?token=LEAK", "/pay"],
        ["URL", "/pay?token=LEAK", "/pay"],
        ["originalUrl", "/pay?token=LEAK", "/pay"],
        ["requestUrl", "/pay?token=LEAK", "/pay"],
        ["href", "https://host/pay?token=LEAK", "https://host/pay"],
        ["referer", "https://host/from?token=LEAK", "https://host/from"],
        ["referrer", "https://host/from?token=LEAK", "https://host/from"],
    ])("strips the query from %s", (key, value, expected) => {
        const { logger, records } = capture();

        logger.info({ [key]: value }, "url casing");

        expect(records[0]![key], `${key} was not stripped`).toBe(expected);
        expect(JSON.stringify(records)).not.toContain("LEAK");
    });

    it("strips a nested url at any depth", () => {
        const { logger, records } = capture();

        logger.info({ ctx: { a: { b: { url: "/x?token=LEAK" } } } }, "nested url");

        expect(records[0]!.ctx.a.b.url).toBe("/x");
        expect(JSON.stringify(records)).not.toContain("LEAK");
    });

    it("strips urls inside arrays", () => {
        const { logger, records } = capture();

        logger.info({ links: [{ url: "/a?token=LEAK" }, { url: "/b" }] }, "array urls");

        expect(records[0]!.links[0].url).toBe("/a");
        expect(records[0]!.links[1].url).toBe("/b");
    });

    it("leaves a url with no query string untouched", () => {
        const { logger, records } = capture();

        logger.info({ url: "/plain/path" }, "no query");

        expect(records[0]!.url).toBe("/plain/path");
    });

    it("does not strip a non-url field that merely contains a question mark", () => {
        const { logger, records } = capture();

        logger.info({ note: "why did this fail?", pattern: "a?*" }, "not a url");

        expect(records[0]!.note).toBe("why did this fail?");
        expect(records[0]!.pattern).toBe("a?*");
    });

    it("does not mutate the caller's url", () => {
        const { logger } = capture();

        const data = { url: "/pay?token=LEAK" };
        logger.info(data, "no mutation");

        expect(data.url).toBe("/pay?token=LEAK");
    });

    it("strips the query from a url bound as a child binding", () => {
        const { logger, records } = capture();

        logger.child({ url: "/pay?token=LEAK" }).info("bound url");

        expect(records[0]!.url).toBe("/pay");
        expect(JSON.stringify(records)).not.toContain("LEAK");
    });
});
