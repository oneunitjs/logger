import http from "node:http";
import { createLogger, createHttpLogger } from "../../src/index.js";

const logger = createLogger({ mode: "development" });
const httpLogger = createHttpLogger({
    logger,
    serializers: {
        excludeQueryString: true,
    },
});

const server = http.createServer((req, res) => {
    httpLogger(req, res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
});

if (process.env.RUN_SERVER === "true") {
    server.listen(3000, () => {
        logger.info("HTTP example server listening on port 3000");
    });
}

