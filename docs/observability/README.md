# Observability

The gateway serves Prometheus metrics at `GET /metrics` (same port as the API, unauthenticated, **not** on the Ingress). Set `METRICS_ENABLED=false` to turn it off.

| Metric | Type | Labels |
|---|---|---|
| `mcp_gateway_tool_calls_total` | counter | `server`, `tool`, `source` (`mcp`/`chat`), `outcome` |
| `mcp_gateway_tool_call_duration_seconds` | histogram | `server`, `tool`, `source` |
| `mcp_gateway_upstream_up` | gauge | `server` (1 connected, 0 not; disabled servers omitted) |
| `mcp_gateway_upstream_tools` | gauge | `server` |
| `mcp_gateway_upstream_last_check_timestamp_seconds` | gauge | `server` |
| `mcp_gateway_search_tools_total` / `_results` | counter / histogram | `source` |

Plus the standard `process_*` / `nodejs_*` metrics.

- **Outcomes**: `success`, `tool_error`, `timeout`, `unreachable`, `rejected`, `denied`. The error rate counts the three failure outcomes (`tool_error|timeout|unreachable`) over everything except `denied|rejected`.
- **`server`/`tool` are never user input.** A call that matches no tool is `server="unknown",tool="unknown"`, so label cardinality is bounded by the tools your upstreams expose.
- **Replicas**: counters are per pod, so use `sum by (...)`. Upstream gauges come from Postgres at scrape time, so every replica reports the same value; use `max by (server)`.

## Request IDs

Every response carries `X-Request-ID`. A well-formed inbound value (`[A-Za-z0-9._-]{8,128}`) is kept so a trace can span services; otherwise one is generated. The ID is in every JSON log line (`requestId`) and in the audit row (`audit_log.request_id`, filter with `GET /api/audit?requestId=...`, shown on the dashboard's Audit page). One chat turn or JSON-RPC batch shares one ID across its audit rows. It is not forwarded to upstream servers.

## Scraping

```bash
helm upgrade ... \
  --set gateway.gateway.metrics.serviceMonitor.enabled=true \
  --set gateway.gateway.metrics.serviceMonitor.labels.release=<your prometheus release> \
  --set global.networkPolicy.metricsScrape.enabled=true \
  --set global.networkPolicy.metricsScrape.namespace=monitoring
```

The ServiceMonitor renders only when the cluster has the `monitoring.coreos.com/v1` API. The NetworkPolicy flag adds an ingress rule for Prometheus pods (`global.networkPolicy.metricsScrape.podLabels`) on port 8080.

Files here: `grafana-dashboard.json` (import in Grafana; pick your Prometheus data source) and `alerts.yaml` (example `PrometheusRule`).
