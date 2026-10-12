import { useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import {
  useEffectivePermissions,
  usePermissions,
  useServers,
  useSetRule,
  useUsers,
} from "@/api/hooks";
import type {
  EffectiveTool,
  PermissionRule,
  PermissionSubject,
  RuleEffect,
  Server,
} from "@/api/types";
import { NativeSelect } from "@/components/NativeSelect";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const ROLE_VALUE = "role:member";

function parseSubject(value: string): PermissionSubject {
  return value === ROLE_VALUE ? { role: "member" } : { userId: value.slice("user:".length) };
}

function ruleMatches(rule: PermissionRule, subject: PermissionSubject): boolean {
  return "userId" in subject
    ? rule.subject.type === "user" && rule.subject.userId === subject.userId
    : rule.subject.type === "role" && rule.subject.role === subject.role;
}

/** Why a tool is shown as it is, in a few words. */
function reasonText(e: EffectiveTool): string {
  if (e.reason === "default") return "no rule";
  if (!e.rule) return "";
  const who = e.rule.subjectType === "user" ? "personal" : "role";
  const what = e.rule.toolName === null ? "server" : "tool";
  return `${who} ${what} rule`;
}

interface RowProps {
  label: string;
  hint?: string;
  rule: PermissionRule | undefined;
  effective?: EffectiveTool;
  subjectLabel: string;
  onChange: (effect: RuleEffect | null) => void;
  busy: boolean;
}

function RuleRow({ label, hint, rule, effective, subjectLabel, onChange, busy }: RowProps) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-mono text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </TableCell>
      <TableCell className="w-44">
        <NativeSelect
          aria-label={`Rule for ${subjectLabel} on ${label}`}
          value={rule?.effect ?? "inherit"}
          disabled={busy}
          onChange={(e) =>
            onChange(e.target.value === "inherit" ? null : (e.target.value as RuleEffect))
          }
        >
          <option value="inherit">Inherit</option>
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
        </NativeSelect>
      </TableCell>
      <TableCell className="w-56">
        {effective && (
          <div className="flex items-center gap-2">
            <Badge
              className={cn(
                effective.allowed
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-orange-100 text-orange-800",
              )}
            >
              {effective.allowed ? "Allowed" : "Hidden"}
            </Badge>
            <span className="text-xs text-muted-foreground">{reasonText(effective)}</span>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function ServerCard(props: {
  server: Server;
  subject: PermissionSubject;
  subjectLabel: string;
  rules: PermissionRule[];
  effective: Map<string, EffectiveTool>;
  busy: boolean;
  onSet: (serverSlug: string, toolName: string | null, effect: RuleEffect | null) => void;
}) {
  const { server, subject, rules } = props;
  const mine = rules.filter((r) => r.serverSlug === server.slug && ruleMatches(r, subject));
  const find = (toolName: string | null) => mine.find((r) => r.toolName === toolName);
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <h2>{server.name}</h2>
          <code className="text-xs font-normal text-muted-foreground">{server.slug}</code>
          <StatusBadge status={server.status} reason={server.lastError} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Result for them</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <RuleRow
              label="Whole server"
              hint="Every tool, including ones added later"
              rule={find(null)}
              subjectLabel={props.subjectLabel}
              busy={props.busy}
              onChange={(effect) => props.onSet(server.slug, null, effect)}
            />
            {server.tools.map((tool) => (
              <RuleRow
                key={tool.name}
                label={tool.upstreamName}
                rule={find(tool.upstreamName)}
                effective={props.effective.get(tool.name)}
                subjectLabel={props.subjectLabel}
                busy={props.busy}
                onChange={(effect) => props.onSet(server.slug, tool.upstreamName, effect)}
              />
            ))}
            {server.tools.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-sm text-muted-foreground">
                  No tools listed yet. A whole-server rule still applies.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function PermissionsPage() {
  const servers = useServers();
  const users = useUsers();
  const rules = usePermissions();
  const setRule = useSetRule();
  const [value, setValue] = useState(ROLE_VALUE);
  const subject = useMemo(() => parseSubject(value), [value]);
  const effective = useEffectivePermissions(subject);

  const members = (users.data ?? []).filter((u) => u.role === "member");
  const subjectLabel =
    value === ROLE_VALUE
      ? "all members"
      : (members.find((u) => `user:${u.id}` === value)?.email ?? "this member");
  const effectiveByName = useMemo(
    () => new Map((effective.data ?? []).map((e) => [e.name, e])),
    [effective.data],
  );

  const onSet = (serverSlug: string, toolName: string | null, effect: RuleEffect | null) => {
    const existing = (rules.data ?? []).find(
      (r) => r.serverSlug === serverSlug && r.toolName === toolName && ruleMatches(r, subject),
    );
    setRule.mutate(
      { subject, serverSlug, toolName, effect, existingId: existing?.id },
      {
        onSuccess: () => toast.success("Permissions updated"),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const error = servers.error ?? rules.error ?? users.error;
  return (
    <>
      <PageHeader
        title="Permissions"
        description="Choose which tools members can see and call. A hidden tool is missing from their tools/list and from the chat agent, and a direct call is refused and logged as denied. Admins are never restricted."
      />
      <Card className="mb-6">
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-[18rem_1fr]">
          <Field>
            <FieldLabel htmlFor="perm-subject">Applies to</FieldLabel>
            <NativeSelect
              id="perm-subject"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value={ROLE_VALUE}>All members</option>
              {members.map((u) => (
                <option key={u.id} value={`user:${u.id}`}>
                  {u.name} ({u.email})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <p className="self-end text-sm text-muted-foreground">
            Everything is allowed unless a rule says otherwise. The most specific rule wins: a rule
            for one person beats a rule for all members, a tool beats its server, and deny beats
            allow when they are equally specific.
          </p>
        </CardContent>
      </Card>

      {error && <p role="alert">Couldn't load permissions: {errorMessage(error)}</p>}
      {servers.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {(servers.data ?? [])
        .filter((s) => s.enabled)
        .map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            subject={subject}
            subjectLabel={subjectLabel}
            rules={rules.data ?? []}
            effective={effectiveByName}
            busy={setRule.isPending}
            onSet={onSet}
          />
        ))}
      {servers.data && servers.data.every((s) => !s.enabled) && (
        <p className="text-sm text-muted-foreground">No enabled servers yet.</p>
      )}
    </>
  );
}
