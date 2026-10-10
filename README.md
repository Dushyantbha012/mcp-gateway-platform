# WooCommerce Team MCP Gateway

A WooCommerce hosting platform with a team MCP gateway on Kubernetes —
built for the Urumi AI FDE Internship Round 1 assignment.

Planning docs (architecture, phased build plan, testing strategy, progress
log) live outside this repo at [`../docs`](../docs) during development.
This README will be filled in with real setup instructions as each phase
ships — see `../docs/03-phased-plan.md` for what's next.

## Layout (planned)

```
woocommerce-mcp/   # the MCP server we write ourselves, talks to WooCommerce REST API
gateway/           # backend: MCP client to every upstream, MCP server to every downstream caller, REST API, chat agent
dashboard/         # React/Vite admin + member UI
helm/              # umbrella Helm chart, values-local.yaml / values-prod.yaml
```

Nothing is implemented yet — this is the scaffold commit.
