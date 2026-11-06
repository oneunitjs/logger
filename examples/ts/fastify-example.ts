import Fastify from "fastify";
import { createLogger } from "../../src/index.js";

const fastify = Fastify({
    loggerInstance: createLogger({ mode: "development" }),
});

fastify.get("/users", async (request) => {
    request.log.info({ query: request.query }, "Fetched users");
    return { status: "ok" };
});

if (process.env.RUN_SERVER === "true") {
    fastify.listen({ port: 3000 }, (err) => {
        if (err) {
            fastify.log.error(err);
            process.exit(1);
        }
    });
}

