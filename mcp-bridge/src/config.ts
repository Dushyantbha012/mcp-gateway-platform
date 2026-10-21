export interface BridgeConfig {
  /** The stdio MCP server to run: everything after `--`. */
  command: string;
  args: string[];
  authToken: string;
  port: number;
  /** How long one tools/call may take before the caller gets an error. */
  timeoutMs: number;
  /** How long the child may take to answer `initialize` (an image may install packages first). */
  startupTimeoutMs: number;
}

const USAGE = "usage: mcp-bridge -- <command> [args...]";

/**
 * argv is the process's own (`mcp-bridge -- uvx mcp-server-time`); env carries
 * the token, so it never shows up in `ps` or the pod spec's args.
 */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): BridgeConfig {
  const sep = argv.indexOf("--");
  const [command, ...args] = sep === -1 ? [] : argv.slice(sep + 1);
  if (!command) throw new Error(USAGE);

  const authToken = env.BRIDGE_AUTH_TOKEN ?? "";
  if (authToken.length < 16) throw new Error("BRIDGE_AUTH_TOKEN must be set (16+ characters)");

  const port = Number(env.BRIDGE_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BRIDGE_PORT must be a port number, got '${env.BRIDGE_PORT}'`);
  }
  const ms = (name: string, fallback: number) => {
    const v = Number(env[name] ?? fallback);
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`${name} must be a positive integer, got '${env[name]}'`);
    }
    return v;
  };
  return {
    command,
    args,
    authToken,
    port,
    timeoutMs: ms("BRIDGE_TIMEOUT_MS", 60_000),
    startupTimeoutMs: ms("BRIDGE_STARTUP_TIMEOUT_MS", 180_000),
  };
}

/**
 * The child gets the container's environment (that is how an image is
 * configured) minus the bridge's own settings: the server it runs must never
 * see the token that guards it.
 */
export function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !k.startsWith("BRIDGE_")) out[k] = v;
  }
  return out;
}
