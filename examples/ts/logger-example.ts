import { createLogger, withContext } from "../../src/index.js";

const logger = createLogger({ mode: "development" });

logger.info("Service initialized");
logger.warn({ latencyMs: 340 }, "Database query took longer than threshold");
logger.error(new Error("Connection reset"), "Upstream service failure");

// Child loggers inherit parent configuration and redact bindings automatically
const child = logger.child({ requestId: "req-123", apiKey: "secret_live_key" });
child.info("Handling request");

const contextualLogger = withContext(logger, {
    requestId: "req-456",
    correlationId: "corr-789",
    tenantId: "t-001",
});
contextualLogger.info("Contextual message");

