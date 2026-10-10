{{/* Base name for every dashboard resource: "<release>-dashboard". */}}
{{- define "dashboard.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "dashboard.labels" -}}
app.kubernetes.io/part-of: {{ include "dashboard.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "dashboard.selector" -}}
app.kubernetes.io/instance: {{ include "dashboard.fullname" . }}
app.kubernetes.io/component: dashboard
{{- end -}}

{{- define "dashboard.gatewayService" -}}
{{- .Values.gatewayService | default (printf "%s-gateway" .Release.Name) -}}
{{- end -}}

{{- define "dashboard.url" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls) .Values.ingress.host -}}
{{- end -}}
