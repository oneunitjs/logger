import pino from "pino";

import type { TransportOptions, TransportTarget } from "../types.js";

function isWritableStream(value: unknown): value is NodeJS.WritableStream {
    return typeof value === "object" && value !== null && typeof (value as NodeJS.WritableStream).write === "function";
}

export function createTransport(
    options: TransportOptions = {},
): pino.TransportMultiOptions {
    const {
        target = "pretty",
        destination,
        options: targetOptions = {},
        level = "trace",
    } = options;

    switch (target) {
        case "pretty": {
            const options_: Record<string, unknown> = {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
                ...targetOptions,
            };

            // Previously `destination` was accepted but silently dropped for
            // the pretty target, so logs went to stdout instead of the
            // requested destination.
            if (typeof destination === "string") {
                options_.destination = destination;
            } else if (isWritableStream(destination)) {
                options_.destination = destination;
            }

            return {
                targets: [{
                    level,
                    target: "pino-pretty",
                    options: options_,
                }],
            };
        }

        case "file": {
            if (!destination || typeof destination !== "string") {
                throw new Error("File transport requires a destination path");
            }
            return {
                targets: [{
                    level,
                    target: "pino/file",
                    options: { destination, ...targetOptions },
                }],
            };
        }

        case "stream": {
            if (!isWritableStream(destination)) {
                throw new Error("Stream transport requires a writable stream");
            }
            return {
                targets: [{
                    level,
                    target: "pino/file",
                    options: { destination, ...targetOptions },
                }],
            };
        }

        default:
            throw new Error(`Unknown transport target: ${target as string}`);
    }
}

export function createMultiTransport(
    transports: TransportTarget[],
): pino.TransportMultiOptions {
    if (!Array.isArray(transports) || transports.length === 0) {
        throw new Error("createMultiTransport requires at least one transport");
    }

    const targets: Array<pino.TransportTargetOptions> = [];

    for (const t of transports) {
        const transport = createTransport({
            target: t.target,
            destination: t.destination,
            options: t.options,
            level: t.level,
        });

        for (const target of transport.targets) {
            targets.push({ ...target, level: t.level ?? target.level ?? "trace" } as pino.TransportTargetOptions);
        }
    }

    return { targets };
}
