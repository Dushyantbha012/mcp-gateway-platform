/** Fixed ports for the E2E stack; override if they clash with something local. */
export const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT ?? 8790);
export const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 8791);
export const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT ?? 4173);
export const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
