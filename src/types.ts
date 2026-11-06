import type pino from "pino";

/** Re-exported Pino types for consumers. */
export type Logger = pino.Logger;
export type Level = pino.Level;
export type LevelWithSilent = pino.LevelWithSilent;
export type DestinationStream = pino.DestinationStream;

/** Logger mode. */
export type LoggerMode = "development" | "production" | "test";

/** A redaction handler transforms a sensitive value before it is masked. */
export type RedactionHandler = (
    value: unknown,
    key: string,
    context: RedactionContext,
) => unknown;

/** Context passed to a redaction handler. */
export interface RedactionContext {
    /** Dot-separated path to the key being redacted. */
    path: string[];
    /** Current nesting depth. */
    depth: number;
    /** Whether the value is a logger child binding. */
    isBinding: boolean;
}

/** A single redaction rule. Matches by key name or path pattern. */
export interface RedactionRule {
    /** Key names to match (case-insensitive). */
    keys?: string[];
    /** Path pattern (regex tested against dot-joined key path). */
    path?: RegExp;
    /** Custom handler that transforms the value before masking. */
    handler?: RedactionHandler;
    /** Override the default mask string for this rule. */
    mask?: string;
}

/** Audit configuration for redaction events. */
export interface AuditConfig {
    enabled: boolean;
    sink?: DestinationStream;
    eventLevel?: "warn" | "info";
}

/** Redaction engine configuration. */
export interface RedactionConfig {
    /** Additional case-insensitive sensitive keys (merged with defaults). */
    keys?: string[] | undefined;
    /** Named redaction rules applied by key or path pattern. */
    rules?: RedactionRule[] | undefined;
    /** Maximum recursion depth for the walker. Default 100. */
    maxDepth?: number | undefined;
    /** Replacement string for redacted values. Default "[REDACTED]". */
    replacement?: string | undefined;
    /** When enabled, redaction events are emitted to an audit sink. */
    audit?: AuditConfig | undefined;
    /** When set, only these header names are allowed through; others are redacted. */
    headerAllowlist?: string[] | undefined;
    /** When true, Authorization headers are normalized to [REDACTED]. */
    normalizeAuth?: boolean | undefined;
}

/** Resolved (fully-applied) reconfiguration. */
export interface ResolvedRedactionConfig {
    keys: Set<string>;
    rules: RedactionRule[];
    maxDepth: number;
    replacement: string;
    audit: AuditConfig | null;
    headerAllowlist: Set<string> | null;
    normalizeAuth: boolean;
}

/** Redaction statistics collected during a log call. */
export interface RedactionStats {
    /** Total number of fields masked. */
    masked: number;
    /** Total number of fields walked. */
    walked: number;
    /** Paths of all masked fields (dot-joined). */
    paths: string[];
}

/** Standardized contextual metadata attached to every log line. */
export interface LogContext {
    service?: string;
    env?: LoggerMode;
    version?: string;
    tenantId?: string;
    correlationId?: string;
    requestId?: string;
    [key: string]: unknown;
}

/** Configuration options for `createLogger`. */
export interface LoggerOptions {
    mode?: LoggerMode;
    level?: string;
    context?: LogContext;
    serializers?: SerializerOptions;
    redaction?: RedactionConfig;
    childBindings?: Record<string, unknown>;
    destination?: NodeJS.WritableStream;
    pino?: Omit<pino.LoggerOptions, "serializers" | "formatters" | "base" | "timestamp">;
}

/** Options controlling headers, query, and query string emission. */
export interface SerializerOptions {
    excludeQuery?: boolean | undefined;
    excludeHeaders?: boolean | undefined;
    excludeQueryString?: boolean | undefined;
    /** When set, only these header names are allowed through; others are redacted. */
    headerAllowlist?: string[] | undefined;
    /** When true, Authorization headers are normalized to [REDACTED]. */
    normalizeAuth?: boolean | undefined;
}

/** Request interface accepted by `createSerializers().req`. */
export interface CustomRequest {
    method?: string;
    url?: string;
    host?: string;
    hostname?: string;
    headers?: Record<string, string | string[] | undefined>;
    remoteAddress?: string;
    remotePort?: number;
    protocol?: string;
    queryString?: string;
    query?: Record<string, unknown>;
    id?: string | number;
    socket?: { remoteAddress?: string; remotePort?: number };
}

/** Response interface accepted by `createSerializers().res`. */
export interface CustomResponse {
    statusCode?: number;
    headers?: Record<string, string | string[] | undefined>;
}

/** Configuration options for `createHttpLogger`. */
export interface HttpLoggerOptions {
    loggerOptions?: { mode?: LoggerMode; context?: LogContext; redaction?: RedactionConfig };
    logger?: pino.Logger;
    serializers?: SerializerOptions;
    excludeQueryString?: boolean;
}

/** A single transport target for `createMultiTransport`. */
export interface TransportTarget {
    level?: string | undefined;
    target: "pretty" | "file" | "stream";
    destination?: NodeJS.WritableStream | string | undefined;
    options?: Record<string, unknown> | undefined;
}

/** Target, destination, level, and options for `createTransport`. */
export interface TransportOptions {
    target?: "pretty" | "file" | "stream" | undefined;
    destination?: NodeJS.WritableStream | string | undefined;
    options?: Record<string, unknown> | undefined;
    level?: string | undefined;
    /** When true, flushes the transport on process exit. Default true. */
    autoFlush?: boolean | undefined;
}

/** Transport lifecycle methods for graceful shutdown. */
export interface TransportLifecycle {
    /** Flushes all pending log writes to the destination. */
    flush(): Promise<void>;
    /** Closes the transport and releases resources. */
    close(): Promise<void>;
}

/** Transport preset factory options. */
export interface TransportPresetOptions {
    level?: string;
    destination?: NodeJS.WritableStream | string;
    options?: Record<string, unknown>;
}

/** Environment preset name. */
export type EnvPreset = "development" | "production" | "test" | "ci";

/** Validation error for invalid logger configuration. */
export interface ConfigValidationError {
    field: string;
    message: string;
    suggestion?: string;
}

/** Result of configuration validation. */
export interface ConfigValidationResult {
    valid: boolean;
    errors: ConfigValidationError[];
}

/** Environment preset options. */
export interface EnvPresetOptions {
    service?: string;
    version?: string;
    level?: string;
}
