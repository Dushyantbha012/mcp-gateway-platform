import type { ReactNode } from "react";
import { LogoMark } from "@/components/doodles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The centred card used by the logged-out pages (login, invite). */
export function AuthCard(props: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <p className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
        <LogoMark className="size-9" /> MCP Gateway
      </p>
      <Card
        className="w-full max-w-sm animate-in fade-in zoom-in-95 duration-500"
        style={{ ["--card-spacing" as string]: "1.75rem" }}
      >
        <CardHeader>
          <CardTitle className="text-2xl">
            <h1>{props.title}</h1>
          </CardTitle>
          {props.description && (
            <CardDescription className="pt-1">{props.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>{props.children}</CardContent>
      </Card>
    </div>
  );
}
