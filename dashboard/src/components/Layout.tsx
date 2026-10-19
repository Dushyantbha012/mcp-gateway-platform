import { ChevronsUpDown, KeyRound, LogOut, Search } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useLogout, useMe } from "@/api/hooks";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { ADMIN_NAV, ALL_NAV, WORKSPACE_NAV, type NavItem } from "@/components/nav";
import { LogoMark } from "@/components/doodles";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

function initials(name?: string) {
  return (name ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const { pathname } = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    onClick={() => isMobile && setOpenMobile(false)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function AppSidebar({ onChangePassword }: { onChangePassword: () => void }) {
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const isAdmin = me?.role === "admin";
  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <LogoMark />
          <div className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <div className="truncate text-[15px] font-semibold leading-none tracking-tight">
              MCP Gateway
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">Control plane</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main" className="contents">
          <NavGroup label="Workspace" items={WORKSPACE_NAV} />
          {isAdmin && <NavGroup label="Admin" items={ADMIN_NAV} />}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label="Account menu"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-gradient-to-br from-[oklch(0.78_0.14_250)] to-[oklch(0.62_0.2_295)] text-xs font-semibold text-white">
                  {initials(me?.name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{me?.name}</span>
                <span className="truncate text-xs text-muted-foreground capitalize">
                  {me?.role}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{me?.name}</div>
              <div className="text-xs text-muted-foreground">{me?.email}</div>
              <div className="mt-1 text-xs text-muted-foreground capitalize">{me?.role}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onChangePassword}>
              <KeyRound /> Change password
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => logout.mutate(undefined, { onSettled: () => navigate("/login") })}
            >
              <LogOut /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function currentTitle(pathname: string) {
  return ALL_NAV.find((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to)))?.label;
}

export function Layout() {
  const [changingPassword, setChangingPassword] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();
  const isChat = pathname.startsWith("/chat");

  return (
    <SidebarProvider>
      <AppSidebar onChangePassword={() => setChangingPassword(true)} />
      <SidebarInset className="bg-transparent">
        <header className="glass sticky top-3 z-10 mx-3 mt-3 flex h-14 shrink-0 items-center gap-2 rounded-full px-3 sm:mx-6">
          <SidebarTrigger aria-label="Toggle sidebar" className="rounded-full" />
          <Separator
            orientation="vertical"
            className="mx-1 h-4 self-center data-vertical:self-center"
          />
          <span className="text-sm font-semibold tracking-tight">{currentTitle(pathname)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="size-9 justify-center gap-2 bg-muted/70 px-0 font-normal text-muted-foreground sm:h-9 sm:w-64 sm:justify-start sm:px-4"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search className="size-4" />
              <span className="hidden sm:inline">Search…</span>
              <kbd className="chip pointer-events-none ml-auto hidden rounded-full px-2 font-mono text-[10px] text-muted-foreground sm:inline">
                ⌘K
              </kbd>
            </Button>
            <ThemeToggle />
          </div>
        </header>
        <div
          className={
            isChat
              ? "mx-auto w-full max-w-5xl px-4 py-6"
              : "mx-auto w-full max-w-7xl px-4 pb-12 pt-8 sm:px-8"
          }
        >
          <div key={pathname} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </SidebarProvider>
  );
}
