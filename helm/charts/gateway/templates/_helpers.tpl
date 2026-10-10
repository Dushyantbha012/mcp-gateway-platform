{{/* Base name for every gateway resource: "<release>-gateway". */}}
{{- define "gateway.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "gateway.labels" -}}
app.kubernetes.io/part-of: {{ include "gateway.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component. Usage: include "gateway.selector" (list . "postgres") */}}
{{- define "gateway.selector" -}}
app.kubernetes.io/instance: {{ include "gateway.fullname" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- define "gateway.url" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls) .Values.ingress.host -}}
{{- end -}}

{{/* The store subchart's MCP Service in this release, unless overridden. */}}
{{- define "gateway.woocommerceUrl" -}}
{{- if .Values.seedWoocommerce.url -}}
{{- .Values.seedWoocommerce.url -}}
{{- else -}}
{{- printf "http://%s-store-woocommerce-mcp.%s.svc.cluster.local:3000/mcp" .Release.Name .Release.Namespace -}}
{{- end -}}
{{- end -}}
