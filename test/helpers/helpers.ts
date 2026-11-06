import { Writable } from "node:stream";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import pino from "pino";

import { createLogger } from "../../src/logger/logger.js";
import type { LoggerOptions } from "../../src/types.js";

/**
 * Shared test utilities.
 *
 * Everything here goes through the package's public entry points rather than
 * reaching into pino's internals, so the tests assert what a consumer actually
 * gets. That distinction matters: child-logger binding redaction and the
 * redaction formatter are both wired up by `createLogger`, so a logger built
 * directly with `pino()` exercises different code and can hide real defects.
 */

export const REDACTED = "[REDACTED]";

export interface Captured {
    logger: pino.Logger;
    /** Writable stream collecting emitted lines. */
    stream: NodeJS.WritableStream;
    /** Parsed JSON lines. */
    records: Array<Record<string, any>>;
    /** Raw lines exactly as emitted, for substring assertions. */
    lines: string[];
}

/**
 * A writable stream that collects and parses everything written to it.
 */
export function collector(): Captured {
    const records: Array<Record<string, any>> = [];
    const lines: string[] = [];

    const stream = new Writable({
        write(chunk, _encoding, callback) {
            const text = chunk.toString().trim();
            if (text) {
                lines.push(text);
                records.push(JSON.parse(text));
            }
            callback();
        },
    });

    const logger = createLogger({ destination: stream });

    return { stream, records, lines, logger };
}

/**
 * Creates a real `createLogger()` instance writing into memory.
 *
 * `test` mode is silent by level, so tests asserting on output must not use it.
 */
export function capture(options?: Partial<LoggerOptions>): Captured {
    const { stream, records, lines } = collector();

    const logger = createLogger({
        ...options,
        destination: stream,
    });

    return { logger, records, lines, stream };
}

/** Asserts that none of `secrets` appears anywhere in the captured output. */
export function assertNoSecret(
    records: Array<Record<string, any>>,
    secrets: Record<string, string>,
    context: string,
): void {
    const emitted = JSON.stringify(records);

    for (const [name, value] of Object.entries(secrets)) {
        expect(emitted, `${context}: "${name}" reached the log sink`).not.toContain(value);
    }
}

/** Starts a server, runs `run` against its port, then always closes it. */
export async function withServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    run: (port: number) => Promise<void>,
): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
        await run(port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

/** Sends one request and waits for its response to end. */
export function request(
    port: number,
    path: string,
    headers: Record<string, string> = {},
): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = http.request({ port, path, headers }, (res) => {
            res.resume();
            res.on("end", () => setTimeout(resolve, 30));
        });
        req.on("error", reject);
        req.end();
    });
}

/** Captures a live `IncomingMessage` for runtime-object tests. */
export async function captureIncomingMessage(): Promise<http.IncomingMessage> {
    let captured: http.IncomingMessage | undefined;

    await withServer(
        (req, res) => {
            captured = req;
            res.end("ok");
        },
        async (port) => {
            await request(port, "/probe?token=leak", { host: "example.test" });
        },
    );

    if (!captured) {
        throw new Error("failed to capture an IncomingMessage");
    }

    return captured;
}
