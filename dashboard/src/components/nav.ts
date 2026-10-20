import {
  Activity,
  CheckCheck,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  Server,
  ShieldCheck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  admin?: boolean;
}

export const WORKSPACE_NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/servers", label: "Servers", icon: Server },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/approvals", label: "Approvals", icon: CheckCheck },
  { to: "/keys", label: "API keys", icon: KeyRound },
];

export const ADMIN_NAV: NavItem[] = [
  { to: "/team", label: "Team", icon: Users, admin: true },
  { to: "/permissions", label: "Permissions", icon: ShieldCheck, admin: true },
  { to: "/audit", label: "Audit log", icon: Activity, admin: true },
];

export const ALL_NAV = [...WORKSPACE_NAV, ...ADMIN_NAV];
