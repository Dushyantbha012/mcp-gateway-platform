import { QueryClientProvider, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { setUnauthorizedHandler } from "@/api/client";
import { keys, useMe } from "@/api/hooks";
import { Layout } from "@/components/Layout";
import { Toaster } from "@/components/ui/sonner";
import { createQueryClient } from "@/lib/queryClient";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuditPage } from "@/pages/AuditPage";
import { InvitePage } from "@/pages/InvitePage";
import { KeysPage } from "@/pages/KeysPage";
import { LoginPage } from "@/pages/LoginPage";
import { ServersPage } from "@/pages/ServersPage";
import { TeamPage } from "@/pages/TeamPage";
import { ToolsPage } from "@/pages/ToolsPage";

/** Any 401 (session expired, logged out elsewhere, user disabled) -> back to login. */
function UnauthorizedBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(keys.me, null);
    });
    return () => setUnauthorizedHandler(() => {});
  }, [qc]);
  return null;
}

export function Providers({ client, children }: { client?: QueryClient; children: ReactNode }) {
  const [qc] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <UnauthorizedBridge />
        {children}
        <Toaster richColors closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageMessage>Loading…</FullPageMessage>;
  if (me.isError) {
    return <FullPageMessage>Can't reach the gateway. Retrying…</FullPageMessage>;
  }
  if (!me.data) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}

/** Hides admin pages from members. The gateway enforces the same rule on every call. */
function AdminOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data?.role !== "admin") return <Navigate to="/servers" replace />;
  return children;
}

function NotFound() {
  return <p className="text-sm text-muted-foreground">No such page.</p>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/servers" replace />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route
          path="team"
          element={
            <AdminOnly>
              <TeamPage />
            </AdminOnly>
          }
        />
        <Route
          path="audit"
          element={
            <AdminOnly>
              <AuditPage />
            </AdminOnly>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
