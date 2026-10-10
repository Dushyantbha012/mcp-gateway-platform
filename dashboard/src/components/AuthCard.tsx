import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The centred card used by the logged-out pages (login, invite). */
export function AuthCard(props: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-sm font-semibold text-muted-foreground">MCP Gateway</p>
          <CardTitle className="text-xl">
            <h1>{props.title}</h1>
          </CardTitle>
          {props.description && <CardDescription>{props.description}</CardDescription>}
        </CardHeader>
        <CardContent>{props.children}</CardContent>
      </Card>
    </div>
  );
}
