import express from "express";
import { createLogger, createHttpLogger } from "../../src/index.js";

const logger = createLogger({ mode: "development" });
const httpLogger = createHttpLogger({
    logger,
    serializers: {
        excludeQueryString: true,
    },
});

const app = express();
app.use(express.json());
app.use(httpLogger);

app.get("/users", (_req, res) => {
    logger.info({ service: "users" }, "Handling user request");
    res.json({ status: "ok" });
});

app.post("/orders", (req, res) => {
    logger.info({ password: "raw_password" }, "Processing order"); // Masked automatically
    res.json({ success: true });
});

if (process.env.RUN_SERVER === "true") {
    app.listen(3000, () => {
        logger.info("Express example server listening on port 3000");
    });
}
