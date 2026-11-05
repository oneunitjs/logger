import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import http from "node:http";

import { createLogger } from "../../src/logger/logger.js";
import { redactLogObject, redactBindings } from "../../src/logger/config.js";
import { withServer, request } from "../helpers/helpers.js";

/**
 * Performance regression tests.
 *
 * These deliberately avoid absolute throughput assertions. Machine speed
 * varies too much for a fixed ops/sec threshold to be meaningful, and a flaky
 * performance gate gets deleted, which is worse than having none.
 *
 * What they do assert is *shape*: that cost scales with the size of the plain
 * data actually logged, and not with the size of an object graph merely
 * referenced by a binding. The historical failure mode is a
 * `logger.child({ req: incomingMessage })` that recursively walked
 * socket -> connection -> parser -> ..., which cost ~26.8us/call against
 * ~1.6us/call for the non-walking implementation. A ratio test catches a
 * return to that behaviour even on a faster or slower machine, because both
 * sides of the ratio are measured on the same run.
 */

/** Times `iterations` calls and returns microseconds per call. */
function measure(iterations: number, fn: (index: number) => void): number {
    // Warm up so the JIT has compiled the path before it is timed.
    for (let i = 0; i < Math.min(iterations, 1_000); i++) {
        fn(i);
    }

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        fn(i);
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);

    return elapsedNs / iterations / 1_000;
}

/** A writable stream that discards, so writing is not the bottleneck. */
const sink = new Writable({
    write(_chunk, _encoding, callback) {
        callback();
    },
});

const ITERATIONS = 50_000;

describe("performance: logging paths", () => {
    const logger = createLogger({ mode: "production", destination: sink });

    it("logs a plain payload", () => {
        const us = measure(ITERATIONS, (i) => {
            logger.info({ id: i, message: "hello", ok: true }, "plain");
        });

        expect(us).toBeGreaterThan(0);
        expect(us).toBeLessThan(500);
    });

    it("redacts a plain payload with a nested secret", () => {
        const us = measure(ITERATIONS, (i) => {
            logger.info({ id: i, user: { password: `secret-${i}`, name: "alice" } }, "redacted");
        });

        expect(us).toBeLessThan(500);
    });

    it("redacts via the walker without copying when nothing matches", () => {
        const payload = { id: 1, name: "alice", tags: ["a", "b"] };

        const us = measure(ITERATIONS, () => {
            redactLogObject(payload);
        });

        // The no-match path allocates nothing, so it must be far cheaper than
        // the copy path below. A regression that clones eagerly shows up here.
        const copyUs = measure(ITERATIONS, () => {
            redactLogObject({ user: { password: "x" } });
        });

        expect(us).toBeLessThan(copyUs * 2);
    });
});

describe("performance: bindings", () => {
    const logger = createLogger({ mode: "production", destination: sink });

    it("binds plain objects without a cost blow-up", () => {
        const us = measure(ITERATIONS, (i) => {
            logger.child({ requestId: `r-${i}`, tenant: "acme" }).info("child");
        });

        expect(us).toBeLessThan(500);
    });

    it("passes a bound runtime object through by reference", () => {
        // Deterministic proof of non-traversal, independent of timing: if the
        // binding were walked and copied, the result would be a different
        // object.
        class Socket {
            constructor(public readonly depth: number) {}
        }

        const request = { socket: new Socket(3) };

        const result = redactBindings({ req: request });

        expect(result.req).toBe(request);
    });

    it("does not scale with the size of a bound runtime object graph", () => {
        // A class instance is non-plain, so the redactor must treat it as an
        // opaque leaf. Two graphs 50x apart must therefore cost the same.
        //
        // Note the contrast with the test below: a *plain* object of the same
        // size is walked, by design, because plain data is exactly what
        // package-level redaction is for. Measuring the redactor directly
        // keeps pino's own serialization (which legitimately scales with
        // output size) out of the measurement.
        class Node {
            public child?: Node;
            public sibling?: Node;

            constructor(public readonly leaf: boolean) {}
        }

        const makeGraph = (depth: number): Node => {
            let node = new Node(false);
            for (let i = 0; i < depth; i++) {
                node = new Node(false);
                node.child = new Node(true);
                node.sibling = new Node(false);
            }
            return node;
        };

        const shallow = makeGraph(2);
        const deep = makeGraph(100);

        const shallowUs = measure(20_000, () => {
            redactBindings({ req: shallow });
        });

        const deepUs = measure(20_000, () => {
            redactBindings({ req: deep });
        });

        // A traversal would be ~50x on the deep graph. Allow generous headroom
        // for measurement noise while still failing on a real traversal.
        expect(deepUs, "bound object graph appears to be traversed").toBeLessThan(shallowUs * 8);
    });

    it("does walk a large plain object, because that is plain data", () => {
        // The complement of the test above. If this stopped scaling the other
        // way, redaction would silently skip large payloads.
        const makePlain = (depth: number): Record<string, unknown> => {
            let node: Record<string, unknown> = { leaf: true };
            for (let i = 0; i < depth; i++) {
                node = { child: node, sibling: { alsoAChild: { leaf: false } } };
            }
            return node;
        };

        const small = measure(2_000, () => {
            redactBindings({ req: makePlain(2) });
        });

        const large = measure(2_000, () => {
            redactBindings({ req: makePlain(100) });
        });

        expect(large, "plain data is no longer being walked").toBeGreaterThan(small);
    });

    it("still walks plain objects nested in bindings", () => {
        // The complement of the test above: cost must scale with plain data
        // that genuinely needs scanning, otherwise redaction would be broken.
        const plain = { user: { password: "x", name: "alice" } };

        const result = redactBindings(plain as Record<string, unknown>);

        expect((result as { user: { password: string } }).user.password).toBe("[REDACTED]");
        expect((result as { user: { name: string } }).user.name).toBe("alice");
    });
});

describe("performance: real request objects", () => {
    it("binds a live IncomingMessage without walking its socket graph", async () => {
        const logger = createLogger({ mode: "production", destination: sink });
        let captured: http.IncomingMessage | undefined;

        await withServer(
            (req, res) => {
                captured = req;
                res.end("ok");
            },
            async (port) => {
                await request(port, "/probe", { host: "example.test" });
            },
        );

        if (!captured) {
            throw new Error("failed to capture an IncomingMessage");
        }

        const message = captured;

        // Cost is per *log call*, so the same message is reused: this measures
        // the redaction path, not allocation of a request.
        const us = measure(20_000, () => {
            logger.child({ req: message }).info("bound request");
        });

        // ~1.6us/call historically for this path. The ceiling here is
        // deliberately loose (still 10x the historical figure) because the
        // point is to catch a return to graph traversal, which costs orders of
        // magnitude more, not to pin down exact throughput.
        expect(us, "binding a live request became expensive").toBeLessThan(20);
    });
});
