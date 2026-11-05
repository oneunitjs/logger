import pino from "pino";
import { pinoHttp } from "pino-http";
import type { HttpLogger } from "pino-http";

import { defineConfig } from "../logger/config.js";
import { createSerializers } from "./serializers.js";
import type { HttpLoggerOptions, SerializerOptions } from "../types.js";

export function createHttpLogger(
    options: HttpLoggerOptions = {},
): HttpLogger {
    const {
        loggerOptions,
        logger,
        serializers,
        excludeQueryString = true,
    } = options;

    // Only build a logger when one was not supplied; previously `defineConfig`
    // ran unconditionally and its result was discarded.
    const resolvedLogger = logger ?? pino(defineConfig(loggerOptions));

    const customSerializers = createSerializers({
        ...serializers,
        excludeQueryString,
        headerAllowlist: loggerOptions?.redaction?.headerAllowlist,
        normalizeAuth: loggerOptions?.redaction?.normalizeAuth,
    });

    // `pino-http`'s published types do not expose the `serializers` option, so
    // the call is suppressed here. The serializer functions are passed through
    // as-is: a type assertion would be erased at runtime and would only
    // re-introduce `any` at this boundary.
    return pinoHttp({
        logger: resolvedLogger,

        serializers: {
            req: customSerializers.req,
            res: customSerializers.res,
            err: customSerializers.err,
        },
    });
}
