import { LogOut, Moon, Monitor, Sun } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useLogout, useMe, useServers } from "@/api/hooks";
import { ALL_NAV } from "@/components/nav";
import { useTheme } from "@/components/ThemeProvider";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

/** Mounted only while the palette is open, so closed pages don't fetch servers for it. */
function ServerItems({ run }: { run: (fn: () => void) => () => void }) {
  const navigate = useNavigate();
  const servers = useServers();
  if (!servers.data || servers.data.length === 0) return null;
  return (
    <CommandGroup heading="Servers">
      {servers.data.map((s) => (
        <CommandItem
          key={s.id}
          value={`server ${s.name} ${s.slug}`}
          onSelect={run(() => navigate("/servers", { state: { open: s.id } }))}
        >
          <span
            className={
              "size-2 rounded-full " +
              (s.status === "connected"
                ? "bg-success"
                : s.status === "unreachable"
                  ? "bg-destructive"
                  : "bg-muted-foreground")
            }
          />
          {s.name}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** ⌘K / Ctrl+K: jump to a page or server, switch theme, log out. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const logout = useLogout();
  const { setTheme } = useTheme();
  const isAdmin = me?.role === "admin";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search pages, servers and actions"
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          {ALL_NAV.filter((n) => !n.admin || isAdmin).map((n) => (
            <CommandItem key={n.to} value={`page ${n.label}`} onSelect={run(() => navigate(n.to))}>
              <n.icon /> {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <ServerItems run={run} />
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="theme light" onSelect={run(() => setTheme("light"))}>
            <Sun /> Light theme
          </CommandItem>
          <CommandItem value="theme dark" onSelect={run(() => setTheme("dark"))}>
            <Moon /> Dark theme
          </CommandItem>
          <CommandItem value="theme system" onSelect={run(() => setTheme("system"))}>
            <Monitor /> System theme
          </CommandItem>
          <CommandItem
            value="log out"
            onSelect={run(() => logout.mutate(undefined, { onSettled: () => navigate("/login") }))}
          >
            <LogOut /> Log out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
