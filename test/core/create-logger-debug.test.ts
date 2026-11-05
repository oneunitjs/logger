import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/logger/logger.js";
import { Writable } from "node:stream";

describe("createLogger debug", () => {
    it("createLogger with destination stream", () => {
        const records: any[] = [];
        const stream = new Writable({
            write(chunk, _enc, cb) {
                records.push(JSON.parse(chunk.toString()));
                cb();
            },
        });
        const log = createLogger({ mode: "production", destination: stream });
        log.info({ test: true }, "hello");
        console.log("records:", JSON.stringify(records));
        expect(records[0].msg).toBe("hello");
    });
});
