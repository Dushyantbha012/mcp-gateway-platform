import { useState } from "react";
import { useSearchParams } from "react-router";
import { errorMessage } from "@/api/client";
import { useDecideOAuth, useLogout, useMe, useOAuthRequest } from "@/api/hooks";
import type { OAuthScope } from "@/api/types";
import { AuthCard } from "@/components/AuthCard";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { leavePage } from "@/lib/urls";

const SCOPE_TEXT: Record<OAuthScope, { label: string; description: string }> = {
  "mcp:read": {
    label: "Read",
    description: "See the tools you can use and call the ones that only read data.",
  },
  "mcp:write": {
    label: "Change data",
    description:
      "Call tools that create, update or delete. Your role and permissions still apply, and held writes still wait for your approval.",
  },
};

const isLoopback = (host: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

/**
 * Where an MCP client's sign-in lands (from the gateway's /oauth/authorize):
 * the user sees which app is asking and for what, and approves or denies.
 * Either way the browser goes back to the app.
 */
export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const id = params.get("req") ?? "";
  const me = useMe();
  const request = useOAuthRequest(id);
  const decide = useDecideOAuth(id);
  const logout = useLogout();
  const [granted, setGranted] = useState<OAuthScope[] | null>(null);

  if (!id || request.isError) {
    return (
      <AuthCard title="Can't connect this app">
        <p className="text-sm text-muted-foreground">
          This sign-in request has expired or was already used. Go back to the app and connect
          again.
        </p>
      </AuthCard>
    );
  }
  if (!request.data) {
    return (
      <AuthCard title="Connect an app">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AuthCard>
    );
  }

  const r = request.data;
  const scopes = granted ?? r.scopes;
  const toggle = (scope: OAuthScope, on: boolean) => {
    let next = on ? [...scopes, scope] : scopes.filter((s) => s !== scope);
    // Writing needs reading (you can't call a tool you can't list).
    if (scope === "mcp:write" && on) next = [...next, "mcp:read"];
    if (scope === "mcp:read" && !on) next = [];
    setGranted(r.scopes.filter((s) => next.includes(s)));
  };
  const submit = (approve: boolean) =>
    decide.mutate(approve ? { approve, scopes } : { approve }, {
      onSuccess: ({ redirectUrl }) => leavePage(redirectUrl),
    });
  const done = decide.isPending || decide.isSuccess;

  return (
    <AuthCard
      title={`Connect ${r.clientName}?`}
      description={
        <>
          <strong className="text-foreground">{r.clientName}</strong> wants to use your MCP Gateway
          tools as <strong className="text-foreground">{me.data?.email}</strong>.
        </>
      }
    >
      <div className="space-y-5 text-sm">
        <div className="space-y-3">
          {r.scopes.map((scope) => (
            <Field key={scope} orientation="horizontal">
              <Switch
                id={`scope-${scope}`}
                checked={scopes.includes(scope)}
                onCheckedChange={(on) => toggle(scope, on)}
                disabled={done}
              />
              <FieldContent>
                <FieldLabel htmlFor={`scope-${scope}`}>{SCOPE_TEXT[scope].label}</FieldLabel>
                <FieldDescription>{SCOPE_TEXT[scope].description}</FieldDescription>
              </FieldContent>
            </Field>
          ))}
        </div>
        <p className="text-muted-foreground">
          You'll be sent back to <code className="text-foreground">{r.redirectHost}</code>
          {isLoopback(r.redirectHost) ? " (an app on this computer)" : ""}. Only approve apps you
          started connecting yourself. You can disconnect it any time under API keys.
        </p>
        <FormError message={decide.isError ? errorMessage(decide.error) : null} />
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => submit(true)}
            disabled={done || scopes.length === 0}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => submit(false)}
            disabled={done}
          >
            Deny
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Not {me.data?.email}?{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => logout.mutate()}
          >
            Log out
          </button>{" "}
          and sign in as someone else.
        </p>
      </div>
    </AuthCard>
  );
}
