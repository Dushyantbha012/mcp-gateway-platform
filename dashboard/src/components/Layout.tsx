import { ChevronDown, LogOut, KeyRound } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useLogout, useMe } from "@/api/hooks";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/chat", label: "Chat" },
  { to: "/servers", label: "Servers" },
  { to: "/tools", label: "Tools" },
  { to: "/keys", label: "API keys" },
  { to: "/team", label: "Team", admin: true },
  { to: "/audit", label: "Audit log", admin: true },
];

export function Layout() {
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const [changingPassword, setChangingPassword] = useState(false);
  const isAdmin = me?.role === "admin";

  return (
    <div className="min-h-svh bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:gap-6">
          <span className="shrink-0 font-semibold">MCP Gateway</span>
          <nav aria-label="Main" className="flex min-w-0 gap-1 overflow-x-auto">
            {NAV.filter((item) => !item.admin || isAdmin).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
                    isActive && "bg-muted font-medium text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Account menu">
                  {me?.name}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-sm font-medium">{me?.name}</div>
                  <div className="text-xs text-muted-foreground">{me?.email}</div>
                  <div className="mt-1 text-xs text-muted-foreground capitalize">{me?.role}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setChangingPassword(true)}>
                  <KeyRound /> Change password
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => logout.mutate(undefined, { onSettled: () => navigate("/login") })}
                >
                  <LogOut /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </div>
  );
}
