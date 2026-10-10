import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { log } from "./logger.js";
import { WcClient } from "./wc/client.js";

const config = loadConfig();
const wc = new WcClient(config.wc);
const app = createApp({ wc, authToken: config.authToken });

const server = app.listen(config.port, "0.0.0.0", () => {
  log("info", "woocommerce-mcp listening", { port: config.port, store: config.wc.baseUrl });
});

// Kubernetes sends SIGTERM on pod shutdown: stop accepting connections and
// let in-flight requests finish.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
