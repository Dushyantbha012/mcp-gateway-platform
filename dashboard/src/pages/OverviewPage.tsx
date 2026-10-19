import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ArrowUpRight as Open,
  Gauge,
  KeyRound,
  MessageSquare,
  Minus,
  Send,
  Server as ServerIcon,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { AUDIT_PAGE, useAudit, useMe, useServers, useStats, useTools } from "@/api/hooks";
import type { AuditEntry, Server, StatsRange } from "@/api/types";
import { ChartDoodle, Orb } from "@/components/doodles";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { duration, timeAgo } from "@/lib/format";
import { OUTCOME } from "@/lib/status";
import { cn } from "@/lib/utils";

const RANGE_LABEL: Record<StatsRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const OUTCOME_COLOR: Record<string, string> = {
  success: "var(--chart-2)",
  tool_error: "var(--chart-3)",
  timeout: "var(--chart-4)",
  unreachable: "var(--chart-4)",
  rejected: "var(--muted-foreground)",
  denied: "var(--chart-5)",
};

const SECTION = "animate-in fade-in slide-in-from-bottom-2 fill-mode-both";

function Trend({
  current,
  previous,
  invert,
}: {
  current: number;
  previous: number;
  invert?: boolean;
}) {
  if (previous === 0 && current === 0) return <span>no change</span>;
  if (previous === 0) return <span>new activity</span>;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <Minus className="size-3" /> flat
      </span>
    );
  }
  const up = pct > 0;
  const good = invert ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-semibold",
        !good && "text-[oklch(0.45_0.2_22)]",
      )}
    >
      <Icon className="size-3" /> {Math.abs(pct)}%
    </span>
  );
}

const MESH = ["mesh-sky", "mesh-lime", "mesh-peach", "mesh-lilac"] as const;

/** A pastel mesh-gradient tile: label and icon on top, a big number, then a footnote. */
function KpiCard(props: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  footer?: ReactNode;
  loading?: boolean;
  tone: number;
  delay: number;
}) {
  const Icon = props.icon;
  return (
    <div
      className={cn(
        "mesh flex min-h-44 flex-col justify-between gap-6 rounded-[1.75rem] p-5 transition-transform duration-300 hover:-translate-y-0.5",
        MESH[props.tone % MESH.length],
        SECTION,
      )}
      style={{ animationDelay: `${props.delay}ms` }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[15px] font-medium leading-tight">{props.label}</span>
        <span className="flex size-9 items-center justify-center rounded-xl bg-white/55 backdrop-blur-sm">
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <div>
        {props.loading ? (
          <Skeleton className="h-12 w-24 bg-white/50" />
        ) : (
          <div className="figure text-5xl leading-none sm:text-6xl">{props.value}</div>
        )}
        <div className="mt-2 min-h-4 text-xs font-medium opacity-80">{props.footer}</div>
      </div>
    </div>
  );
}

function formatBucket(iso: string, bucket: "hour" | "day") {
  const d = new Date(iso);
  return bucket === "hour"
    ? d.toLocaleTimeString(undefined, { hour: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const seriesConfig = {
  success: { label: "Successful", color: "var(--chart-1)" },
  errors: { label: "Errors", color: "var(--chart-4)" },
} satisfies ChartConfig;

function ChartEmpty({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-foreground/15 bg-muted/40 text-sm text-muted-foreground">
      <ChartDoodle />
      <p className="font-medium text-foreground">{text}</p>
    </div>
  );
}

function RangeTabs({ range, onChange }: { range: StatsRange; onChange: (r: StatsRange) => void }) {
  return (
    <Tabs value={range} onValueChange={(v) => onChange(v as StatsRange)}>
      <TabsList aria-label="Time range">
        <TabsTrigger value="24h">24h</TabsTrigger>
        <TabsTrigger value="7d">7d</TabsTrigger>
        <TabsTrigger value="30d">30d</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function AssistantCard({
  name,
  serversUp,
  serversTotal,
}: {
  name: string;
  serversUp: number;
  serversTotal: number;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/chat?q=${encodeURIComponent(q.trim())}` : "/chat");
  };
  const chips = [
    { to: "/servers", icon: ServerIcon, label: "Check servers" },
    { to: "/keys", icon: KeyRound, label: "Create a key" },
    { to: "/tools", icon: Wrench, label: "Browse tools" },
  ];
  return (
    <Card className={cn(SECTION, "relative overflow-hidden")} style={{ animationDelay: "240ms" }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(60%_80%_at_50%_0%,oklch(0.85_0.1_260/45%),transparent)]"
      />
      <CardContent className="relative flex h-full flex-col items-center gap-5 text-center">
        <Orb className="mt-2" />
        <div>
          <h2 className="text-2xl font-semibold leading-tight">
            Hi {name}, what can I help with today?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {serversTotal > 0
              ? `${serversUp} of ${serversTotal} servers are up.`
              : "Connect a server to get started."}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {chips.map((c) => (
            <Link
              key={c.to}
              to={c.to}
              className="chip inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
            >
              <c.icon className="size-3.5 text-muted-foreground" aria-hidden /> {c.label}
            </Link>
          ))}
        </div>
        <form
          onSubmit={submit}
          className="chip mt-auto flex w-full items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5"
        >
          <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={300}
            placeholder="Ask the assistant…"
            aria-label="Ask the assistant"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button type="submit" size="icon" className="size-8" aria-label="Open chat">
            <Send className="size-3.5" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const SLOTS = 12;
const HOUR = 3_600_000;

/** Server-by-hour grid built from the latest audit page: hatched = quiet, blue = healthy calls, amber/red = trouble. */
function ServerTimeline({
  servers,
  calls,
}: {
  servers: Server[] | undefined;
  calls: AuditEntry[] | undefined;
}) {
  const { slots, rows } = useMemo(() => {
    const now = Date.now();
    const end = Math.ceil(now / HOUR) * HOUR;
    const slots = Array.from({ length: SLOTS }, (_, i) => end - (SLOTS - i) * HOUR);
    const rows = (servers ?? []).slice(0, 6).map((s) => {
      const cells = slots.map((start) => {
        const hit = (calls ?? []).filter(
          (c) =>
            (c.server === s.slug || c.server === s.name) &&
            new Date(c.ts).getTime() >= start &&
            new Date(c.ts).getTime() < start + HOUR,
        );
        const bad = hit.filter(
          (c) => c.outcome === "timeout" || c.outcome === "unreachable",
        ).length;
        const warn = hit.filter((c) => c.outcome === "tool_error").length;
        return {
          count: hit.length,
          tone: bad > 0 ? "bad" : warn > 0 ? "warn" : hit.length > 0 ? "ok" : "none",
        } as const;
      });
      return { server: s, cells };
    });
    return { slots, rows };
  }, [servers, calls]);

  const TONE: Record<string, string> = {
    ok: "bg-gradient-to-br from-[oklch(0.72_0.17_250)] to-[oklch(0.6_0.2_270)] text-white shadow-[0_6px_14px_-6px_oklch(0.55_0.2_265/60%)]",
    warn: "bg-gradient-to-br from-[oklch(0.88_0.15_92)] to-[oklch(0.82_0.16_75)] text-[oklch(0.3_0.07_75)]",
    bad: "bg-gradient-to-br from-[oklch(0.72_0.19_25)] to-[oklch(0.62_0.22_15)] text-white",
    none: "hatch",
  };

  return (
    <Card className={cn(SECTION, "min-w-0")} style={{ animationDelay: "300ms" }}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Server activity</CardTitle>
          <CardDescription>Latest calls, hour by hour</CardDescription>
        </div>
        <div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-full bg-[oklch(0.65_0.2_262)]" /> Healthy
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-full bg-[oklch(0.82_0.16_85)]" /> Tool errors
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-full bg-[oklch(0.65_0.22_20)]" /> Failed
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {!servers && <Skeleton className="h-40 w-full" />}
        {servers?.length === 0 && (
          <EmptyState
            icon={ServerIcon}
            title="No servers yet"
            description="Register an MCP server to see its activity here."
          />
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto pb-1">
            <div className="min-w-[34rem]">
              <div
                className="grid items-center gap-1.5"
                style={{ gridTemplateColumns: `9rem repeat(${SLOTS}, minmax(0, 1fr))` }}
              >
                <span />
                {slots.map((t, i) => (
                  <span
                    key={t}
                    className={cn(
                      "rounded-lg py-1 text-center text-[10px] leading-tight text-muted-foreground",
                      i === SLOTS - 1 && "bg-primary font-semibold text-primary-foreground",
                    )}
                  >
                    {new Date(t).toLocaleTimeString(undefined, { hour: "numeric" })}
                  </span>
                ))}
                {rows.map(({ server, cells }) => (
                  <div key={server.id} className="contents">
                    <div className="flex min-w-0 items-center gap-2 pr-2">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          server.status === "connected"
                            ? "bg-success"
                            : server.status === "unreachable"
                              ? "bg-destructive"
                              : "bg-muted-foreground",
                        )}
                      />
                      <span className="truncate text-sm font-medium">{server.name}</span>
                    </div>
                    {cells.map((c, i) => (
                      <span
                        key={i}
                        title={
                          c.count ? `${c.count} ${c.count === 1 ? "call" : "calls"}` : "No calls"
                        }
                        className={cn(
                          "flex h-9 items-center justify-center rounded-xl text-[11px] font-semibold",
                          TONE[c.tone],
                        )}
                      >
                        {c.count > 0 ? c.count : ""}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {rows.length > 0 && calls && calls.length >= AUDIT_PAGE && (
          <p className="mt-3 text-xs text-muted-foreground">
            Based on the latest {AUDIT_PAGE} calls, so busy hours may be undercounted.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ServerHealth({ servers }: { servers: Server[] | undefined }) {
  return (
    <Card className={SECTION} style={{ animationDelay: "340ms" }}>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Server health</CardTitle>
          <CardDescription>Updates every few seconds</CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/servers">
            <Open /> View all
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {!servers && <Skeleton className="h-24 w-full" />}
        {servers?.length === 0 && (
          <EmptyState
            icon={ServerIcon}
            title="No servers yet"
            description="Register an MCP server to expose its tools through the gateway."
            action={
              <Button asChild size="sm">
                <Link to="/servers">Add a server</Link>
              </Button>
            }
          />
        )}
        <ul className="space-y-2">
          {servers?.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-2xl bg-muted/50 px-3 py-2.5 transition-colors hover:bg-muted dark:bg-white/5 dark:hover:bg-white/10"
            >
              <span className="relative flex size-2.5 shrink-0">
                {s.status === "connected" && (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                )}
                <span
                  className={cn(
                    "relative inline-flex size-2.5 rounded-full",
                    s.status === "connected"
                      ? "bg-success"
                      : s.status === "unreachable"
                        ? "bg-destructive"
                        : s.status === "unknown"
                          ? "bg-warning"
                          : "bg-muted-foreground",
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{s.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {s.tools.length} {s.tools.length === 1 ? "tool" : "tools"} ·{" "}
                  {s.enabled ? timeAgo(s.lastCheckedAt) : "disabled"}
                </div>
              </div>
              <StatusBadge status={s.status} reason={s.lastError} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RecentActivity({ rows, pending }: { rows: AuditEntry[]; pending: boolean }) {
  return (
    <Card className={SECTION} style={{ animationDelay: "380ms" }}>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>Latest tool calls through the gateway</CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/audit">
            <Open /> Audit log
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {pending && <Skeleton className="h-40 w-full" />}
        {!pending && rows.length === 0 && (
          <EmptyState
            icon={Activity}
            title="No calls yet"
            description="Tool calls from MCP clients and chat show up here."
          />
        )}
        <ul className="divide-y divide-border/70">
          {rows.slice(0, 7).map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2.5">
              <Badge className={cn("shrink-0", OUTCOME[r.outcome].className)}>
                {OUTCOME[r.outcome].label}
              </Badge>
              <div className="min-w-0 flex-1">
                <code className="block truncate text-xs font-medium">{r.tool}</code>
                <span className="block truncate text-xs text-muted-foreground">{r.userEmail}</span>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <div>{timeAgo(r.ts)}</div>
                <div className="tabular-nums">{duration(r.durationMs)}</div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RequestsChart({ range }: { range: StatsRange }) {
  const stats = useStats(range);
  const s = stats.data;
  const hasCalls = (s?.totals.total ?? 0) > 0;
  const errorRate = s && s.totals.total > 0 ? (s.totals.errors / s.totals.total) * 100 : 0;
  return (
    <Card className={cn(SECTION, "min-w-0")} style={{ animationDelay: "200ms" }}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Requests over time</CardTitle>
          <CardDescription>Tool calls in the last {RANGE_LABEL[range]}</CardDescription>
        </div>
        {s && hasCalls && (
          <div className="text-right">
            <div className="figure text-4xl leading-none">{errorRate.toFixed(1)}%</div>
            <div className="mt-1 text-xs text-muted-foreground">Error rate</div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {stats.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : !hasCalls ? (
          <ChartEmpty text="No calls in this period." />
        ) : (
          <ChartContainer config={seriesConfig} className="h-64 w-full">
            <AreaChart data={s!.series} margin={{ left: 0, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fillSuccess" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-success)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="fillErrors" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-errors)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-errors)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="2 6" />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={24}
                tickFormatter={(v: string) => formatBucket(v, s!.bucket)}
              />
              <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
              <ChartTooltip
                content={
                  <ChartTooltipContent labelFormatter={(v) => formatBucket(String(v), s!.bucket)} />
                }
              />
              <Area
                dataKey="success"
                type="natural"
                strokeWidth={2.5}
                dot={s!.series.length < 2 ? { r: 3 } : false}
                activeDot={{ r: 5, strokeWidth: 3, stroke: "var(--card)" }}
                stroke="var(--color-success)"
                fill="url(#fillSuccess)"
              />
              <Area
                dataKey="errors"
                type="natural"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 5, strokeWidth: 3, stroke: "var(--card)" }}
                stroke="var(--color-errors)"
                fill="url(#fillErrors)"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function BreakdownCards({ range }: { range: StatsRange }) {
  const stats = useStats(range);
  const s = stats.data;
  const outcomeData = (s?.byOutcome ?? []).map((o) => ({
    name: OUTCOME[o.outcome].label,
    key: o.outcome,
    value: o.count,
  }));
  const outcomeConfig = Object.fromEntries(
    outcomeData.map((o) => [o.name, { label: o.name, color: OUTCOME_COLOR[o.key] }]),
  ) satisfies ChartConfig;
  const toolData = (s?.topTools ?? []).map((t) => ({ tool: t.tool, count: t.count }));
  const hasCalls = (s?.totals.total ?? 0) > 0;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className={cn(SECTION, "lg:col-span-2")} style={{ animationDelay: "260ms" }}>
        <CardHeader>
          <CardTitle>Outcomes</CardTitle>
          <CardDescription>How calls ended</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.isPending ? (
            <Skeleton className="h-56 w-full" />
          ) : !hasCalls ? (
            <ChartEmpty text="Nothing to show yet." />
          ) : (
            <ChartContainer config={outcomeConfig} className="mx-auto h-56 w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie
                  data={outcomeData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={56}
                  outerRadius={82}
                  paddingAngle={3}
                  cornerRadius={8}
                  strokeWidth={0}
                >
                  {outcomeData.map((o) => (
                    <Cell key={o.key} fill={OUTCOME_COLOR[o.key]} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="name" />} />
              </PieChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
      <Card className={cn(SECTION, "lg:col-span-3")} style={{ animationDelay: "280ms" }}>
        <CardHeader>
          <CardTitle>Top tools</CardTitle>
          <CardDescription>Most-called tools in the last {RANGE_LABEL[range]}</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : toolData.length === 0 ? (
            <ChartEmpty text="No tool calls in this period." />
          ) : (
            <ChartContainer
              config={{ count: { label: "Calls", color: "var(--chart-5)" } }}
              className="w-full"
              style={{ height: Math.max(160, toolData.length * 36) }}
            >
              <BarChart data={toolData} layout="vertical" margin={{ left: 0, right: 16 }}>
                <CartesianGrid horizontal={false} strokeDasharray="2 6" />
                <YAxis
                  dataKey="tool"
                  type="category"
                  tickLine={false}
                  axisLine={false}
                  width={150}
                  tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)}
                />
                <XAxis type="number" hide />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={999} barSize={14} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function OverviewPage() {
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const [range, setRange] = useState<StatsRange>("24h");
  const servers = useServers();
  const tools = useTools();
  const stats = useStats(range, isAdmin);
  const audit = useAudit({}, false);
  const s = stats.data;
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const online = servers.data?.filter((x) => x.status === "connected").length ?? 0;
  const enabled = servers.data?.filter((x) => x.enabled).length ?? 0;
  const errorRate = s && s.totals.total > 0 ? (s.totals.errors / s.totals.total) * 100 : 0;
  const prevErrorRate =
    s && s.previous.total > 0 ? (s.previous.errors / s.previous.total) * 100 : 0;
  const auditRows = audit.data?.pages[0] ?? [];
  const firstName = me?.name.split(" ")[0] ?? "";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 animate-in fade-in slide-in-from-bottom-1 duration-500">
        <div>
          <span className="dateline">{today}</span>
          <h1 className="mt-1 text-4xl leading-[1.05] sm:text-5xl">
            {me ? (
              <>
                Welcome back,{" "}
                <span className="bg-gradient-to-r from-[oklch(0.6_0.2_262)] to-[oklch(0.62_0.22_305)] bg-clip-text text-transparent">
                  {firstName}
                </span>
              </>
            ) : (
              "Overview"
            )}
          </h1>
          <p className="mt-2 max-w-xl text-[15px] text-muted-foreground">
            Live health of your MCP servers, and how the gateway is being used.
          </p>
        </div>
        {isAdmin && <RangeTabs range={range} onChange={setRange} />}
      </header>

      <section
        aria-label="At a glance"
        className={cn("grid gap-4 sm:grid-cols-2", isAdmin && "xl:grid-cols-4")}
      >
        <KpiCard
          icon={ServerIcon}
          tone={0}
          delay={0}
          label="Servers online"
          loading={servers.isPending}
          value={
            <>
              {online}
              <span className="text-2xl opacity-50"> / {enabled}</span>
            </>
          }
          footer={
            enabled > 0 && online < enabled ? (
              <span className="inline-flex items-center gap-1 font-semibold">
                <AlertTriangle className="size-3" /> {enabled - online} need attention
              </span>
            ) : (
              "All enabled servers healthy"
            )
          }
        />
        <KpiCard
          icon={Wrench}
          tone={1}
          delay={60}
          label="Tools available"
          loading={tools.isPending}
          value={tools.data?.length ?? 0}
          footer="Across all connected servers"
        />
        {isAdmin && (
          <>
            <KpiCard
              icon={Zap}
              tone={2}
              delay={120}
              label="Requests"
              loading={stats.isPending}
              value={s?.totals.total.toLocaleString() ?? 0}
              footer={
                s && (
                  <span className="flex items-center gap-1">
                    <Trend current={s.totals.total} previous={s.previous.total} /> vs previous{" "}
                    {RANGE_LABEL[range]}
                  </span>
                )
              }
            />
            <KpiCard
              icon={Gauge}
              tone={3}
              delay={180}
              label="Error rate"
              loading={stats.isPending}
              value={`${errorRate.toFixed(1)}%`}
              footer={
                s && (
                  <span className="flex items-center gap-1">
                    <Trend current={errorRate} previous={prevErrorRate} invert /> · p95{" "}
                    {duration(s.totals.p95Ms)}
                  </span>
                )
              }
            />
          </>
        )}
      </section>

      <div className={cn("grid gap-4", isAdmin && "xl:grid-cols-3")}>
        {isAdmin && (
          <div className="min-w-0 xl:col-span-2">
            <RequestsChart range={range} />
          </div>
        )}
        <AssistantCard name={firstName} serversUp={online} serversTotal={enabled} />
      </div>

      <ServerTimeline servers={servers.data} calls={isAdmin ? auditRows : undefined} />
      {isAdmin && <BreakdownCards range={range} />}

      <div className={cn("grid gap-4", isAdmin && "xl:grid-cols-2")}>
        <ServerHealth servers={servers.data} />
        {isAdmin && <RecentActivity rows={auditRows} pending={audit.isPending} />}
      </div>
    </div>
  );
}
