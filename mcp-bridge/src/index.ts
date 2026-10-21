import { childEnv, loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { log } from "./logger.js";
import { Upstream } from "./upstream.js";

/**
 * mcp-bridge -- <command> [args...]
 *
 * Runs a stdio MCP server as a child process and serves it as stateless
 * Streamable HTTP on BRIDGE_PORT/mcp, behind a bearer token. Shipped as a
 * self-contained binary so it runs inside any image, whatever its language.
 */
let config;
try {
  config = loadConfig(process.argv, process.env);
} catch (err) {
  console.error(`mcp-bridge: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const upstream = new Upstream(
  { command: config.command, args: config.args, env: childEnv(process.env) },
  (reason) => {
    log("error", reason, { command: config.command });
    process.exit(1);
  },
);
const app = createApp({ upstream, authToken: config.authToken, timeoutMs: config.timeoutMs });
const server = app.listen(config.port, "0.0.0.0", () => {
  log("info", "mcp-bridge listening", { port: config.port, command: config.command });
});

try {
  await upstream.start(config.startupTimeoutMs);
} catch (err) {
  log("error", "the MCP server failed to start", {
    command: config.command,
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "shutting down", { signal });
    server.close(() => void upstream.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
