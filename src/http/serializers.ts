import serializers from "pino-std-serializers";

import type { CustomRequest, CustomResponse, SerializerOptions } from "../types.js";
import { processHeaders, redactLogObject } from "../logger/config.js";

const { req: serializeReq, res: serializeRes } = serializers;

/**
 * Serializes an Error, preserving `cause` chains and `AggregateError.errors`.
 *
 * pino's std `err` serializer flattens an Error into `{ type, message, stack }`
 * but drops `cause` and `errors` (AggregateError). This serializer walks the
 * `cause` chain and serializes nested errors recursively, masking sensitive
 * metadata via the redaction walker (applied upstream by `formatters.log`).
 *
 * Cycles in the `cause` chain are tolerated via a `seen` set.
 */
function serializeErr(error: unknown, seen?: Set<Error>): unknown {
    if (!(error instanceof Error)) {
        return error;
    }

    const localSeen = seen ?? new Set<Error>();
    const result: Record<string, unknown> = {
        type: error.constructor.name,
        message: error.message,
        stack: error.stack,
    };

    // Preserve own enumerable properties (e.g. custom metadata attached via
    // Object.assign), but skip sensitive ones (redaction walker handles
    // masking upstream; we just copy them through).
    for (const key of Object.keys(error)) {
        if (key === "message" || key === "stack") {
            continue;
        }
        try {
            result[key] = (error as unknown as Record<string, unknown>)[key];
        } catch {
            // Skip unreadable properties.
        }
    }

    // Walk the `cause` chain.
    let current: Error | undefined = error as Error;
    let depth = 0;
    while (current && depth < 50) {
        if (localSeen.has(current)) {
            break;
        }
        localSeen.add(current);

        const cause: Error | undefined = (current as Error & { cause?: Error }).cause;
        if (cause instanceof Error) {
            result.cause = serializeErr(cause, localSeen);
        } else if (cause !== undefined && cause !== null) {
            result.cause = cause;
        }

        current = cause;
        depth++;
    }

    // AggregateError exposes an `errors` array.
    if (
        error.constructor.name === "AggregateError" &&
        Array.isArray((error as AggregateError).errors)
    ) {
        result.errors = (error as AggregateError).errors.map((e) => serializeErr(e, localSeen));
    }

    return result;
}

function splitUrl(url: string | undefined): {
    path: string | undefined;
    queryString: string | undefined;
} {
    if (typeof url !== "string") {
        return { path: url, queryString: undefined };
    }

    const index = url.indexOf("?");

    if (index === -1) {
        return { path: url, queryString: undefined };
    }

    return {
        path: url.slice(0, index),
        queryString: url.slice(index + 1),
    };
}

export function createSerializers(
    options: SerializerOptions = {},
) {
    const {
        excludeQuery = false,
        excludeHeaders = false,
        excludeQueryString = true,
        headerAllowlist,
        normalizeAuth = false,
    } = options;

    const headerAllowlistSet = headerAllowlist
        ? new Set(headerAllowlist.map((h) => h.toLowerCase()))
        : null;

    return {
        err: serializeErr,

        req(request: CustomRequest) {
            const serialized = serializeReq(request as Parameters<typeof serializeReq>[0]);

            const {
                query: _query,
                headers: _headers,
                ...base
            } = serialized;

            const socket = request.socket;

            const headerHost = request.headers?.host;
            // A host header may legally repeat; take the first value rather
            // than emitting an array into the `host` field.
            const hostFromHeaders = Array.isArray(headerHost)
                ? headerHost[0]
                : headerHost;

            // `request.host` is absent on raw Node requests, where the host
            // lives in the headers; fall back so the field is never lost.
            const host = request.host
                ?? request.hostname
                ?? hostFromHeaders;

            // The std serializer resolves the URL across frameworks: Express
            // exposes `originalUrl`, hapi/Fastify expose `url.path`, and a raw
            // Node request uses `url`. Falling back to `request.url` alone would
            // drop the original path and could emit the url object verbatim.
            //
            // When the std serializer resolves nothing (a degenerate empty url,
            // or an unrecognised framework object) fall back to a *string*
            // `request.url` rather than dropping the field. The guard matters:
            // hapi exposes `url` as an object, and emitting that verbatim would
            // be worse than omitting it. Fails closed either way, because the
            // query string is split off whatever string is resolved here.
            const resolvedUrl = typeof serialized.url === "string"
                ? serialized.url
                : typeof request.url === "string"
                    ? request.url
                    : undefined;

            const queryString = request.queryString
                ?? splitUrl(resolvedUrl).queryString;

            const { path: urlWithoutQuery } = splitUrl(resolvedUrl);

            const result: Record<string, unknown> = {
                ...base,

                method: request.method ?? base.method,
                // Drop the query string from the logged URL when requested so
                // secrets embedded in it are not written to the sink.
                url: excludeQueryString ? urlWithoutQuery : resolvedUrl,

                host,
                hostname: request.hostname,

                correlationId: request.headers?.["x-correlation-id"],

                remoteAddress: request.remoteAddress ?? socket?.remoteAddress,
                remotePort: request.remotePort ?? socket?.remotePort,

                protocol: request.protocol,
            };

            // Stripping only the URL is not enough: the raw `queryString`
            // field would otherwise carry the same secrets to the sink.
            // An empty query string carries no information; skip it rather
            // than emitting `"queryString":""` on every request.
            if (!excludeQueryString && queryString) {
                result.queryString = queryString;
            }

            if (!excludeHeaders && request.headers) {
                result.headers = processHeaders(
                    request.headers as Record<string, string | string[] | undefined>,
                    headerAllowlistSet,
                    normalizeAuth,
                );
            }

            if (!excludeQuery) {
                const query = serialized.query ?? request.query;
                // Only emit `query` when it carries data; the std serializer
                // returns an empty string for query-less requests. Mask sensitive
                // keys here so a framework's parsed query is never leaked through
                // the serializer (e.g. when `req` arrives as a pino-http child
                // binding and therefore never reaches `formatters.log`).
                if (query && (typeof query !== "object" || Object.keys(query).length > 0)) {
                    result.query = redactLogObject(query);
                }
            }

            return result;
        },

        res(response: CustomResponse) {
            const serialized = serializeRes(response as Parameters<typeof serializeRes>[0]);

            const {
                headers: serializedHeaders,
                statusCode: _statusCode,
                ...base
            } = serialized;

            const result: Record<string, unknown> = {
                ...base,
            };

            // The std serializer yields `statusCode: null` when headers have
            // not been sent yet; emitting an explicit null is noise, so keep
            // the field absent unless a real status code is known.
            const statusCode = response.statusCode ?? _statusCode;
            if (statusCode !== undefined && statusCode !== null) {
                result.statusCode = statusCode;
            }

            if (!excludeHeaders) {
                // The std serializer already reads `getHeaders()` for a raw
                // Node response, where `response.headers` does not exist;
                // prefer the explicit value when one was supplied.
                const headers = response.headers ?? serializedHeaders;

                if (headers && Object.keys(headers).length > 0) {
                    result.headers = processHeaders(
                        headers as Record<string, string | string[] | undefined>,
                        headerAllowlistSet,
                        normalizeAuth,
                    );
                }
            }

            return result;
        },
    };
}
