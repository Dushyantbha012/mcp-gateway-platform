{{/* Base name for every resource in this store: "<release>-store". */}}
{{- define "store.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/part-of: {{ include "store.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component. Usage: include "store.selector" (list . "mysql") */}}
{{- define "store.selector" -}}
app.kubernetes.io/instance: {{ include "store.fullname" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- define "store.wordpressUrl" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls) .Values.ingress.host -}}
{{- end -}}

{{/* In-cluster URL the MCP server uses to reach WordPress (plain HTTP, never leaves the cluster). */}}
{{- define "store.wordpressInternalUrl" -}}
{{- printf "http://%s-wordpress.%s.svc.cluster.local" (include "store.fullname" .) .Release.Namespace -}}
{{- end -}}

{{/*
Env shared by WordPress and the bootstrap Job. The image's generated
wp-config.php reads these at runtime (getenv), so WP-CLI in the Job must see
exactly the same values to load the same site.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ include "store.fullname" . }}-mysql
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mysql.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mysql.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.db }}
      key: password
# Pin the public URL so links/redirects always use the Ingress host, even
# for requests that arrive on the internal Service name.
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.wordpressUrl" . }}');
    define('WP_SITEURL', '{{ include "store.wordpressUrl" . }}');
    {{- if .Values.ingress.tls }}
    if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }
    {{- end }}
{{- end -}}
