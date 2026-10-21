import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useSaveServer } from "@/api/hooks";
import type { Hosted, Server } from "@/api/types";
import { FormError } from "@/components/FormError";
import { HostedServerForm } from "@/components/HostedServerForm";
import { NativeSelect } from "@/components/NativeSelect";
import { STATUS } from "@/lib/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { defaultsFor, serverFormSchema, toInput, type ServerFormValues } from "@/pages/serverForm";

/**
 * Add a server - by URL, or (when hosting is on) by image - or edit one.
 * Mounted fresh each time it opens.
 */
export function ServerFormDialog(props: {
  server?: Server;
  hosted?: Hosted;
  /** Hosting is switched on for this gateway (GET /api/hosted). */
  hostedEnabled?: boolean;
  imageAllowlist?: string[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"url" | "image">(props.hosted ? "image" : "url");
  const adding = !props.server && !props.hosted;
  const title = props.hosted
    ? `Edit ${props.hosted.name}`
    : props.server
      ? `Edit ${props.server.name}`
      : "Add MCP server";
  const imageForm = (
    <HostedServerForm
      hosted={props.hosted}
      imageAllowlist={props.imageAllowlist ?? []}
      onClose={props.onClose}
    />
  );
  const urlForm = <UrlServerForm server={props.server} onClose={props.onClose} />;

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className={cn("sm:max-w-lg", tab === "image" && "sm:max-w-2xl")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {tab === "image"
              ? "The gateway runs the image in its own namespace: non-root, read-only, reachable only by the gateway. Changing anything but the name redeploys it."
              : "The server must speak MCP over Streamable HTTP. Its credential stays on the gateway: no member or MCP client ever sees it."}
          </DialogDescription>
        </DialogHeader>
        {adding && props.hostedEnabled ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as "url" | "image")}>
            <TabsList className="w-full">
              <TabsTrigger value="url">By URL</TabsTrigger>
              <TabsTrigger value="image">By image</TabsTrigger>
            </TabsList>
            <TabsContent value="url" className="pt-2">
              {urlForm}
            </TabsContent>
            <TabsContent value="image" className="pt-2">
              {imageForm}
            </TabsContent>
          </Tabs>
        ) : props.hosted ? (
          imageForm
        ) : (
          urlForm
        )}
      </DialogContent>
    </Dialog>
  );
}

function UrlServerForm(props: { server?: Server; onClose: () => void }) {
  const editing = props.server;
  const save = useSaveServer();
  const form = useForm<ServerFormValues>({
    resolver: zodResolver(serverFormSchema({ hasStoredCredential: !!editing?.hasCredential })),
    defaultValues: defaultsFor(editing),
  });
  const { errors } = form.formState;
  const authType = form.watch("authType");

  const onSubmit = form.handleSubmit((values) =>
    save.mutate(
      { id: editing?.id, input: toInput(values) },
      {
        onSuccess: (saved) => {
          toast.success(`${saved.name} saved - ${STATUS[saved.status].label}`);
          props.onClose();
        },
      },
    ),
  );

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <div className="grid grid-cols-2 gap-4">
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="server-name">Name</FieldLabel>
            <Input id="server-name" aria-invalid={!!errors.name} {...form.register("name")} />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.slug}>
            <FieldLabel htmlFor="server-slug">Slug</FieldLabel>
            <Input
              id="server-slug"
              aria-invalid={!!errors.slug}
              placeholder="github"
              {...form.register("slug")}
            />
            <FieldError errors={[errors.slug]} />
          </Field>
        </div>
        <FieldDescription className="-mt-4">
          Tools appear to clients as <code>{form.watch("slug") || "slug"}__tool_name</code>.
        </FieldDescription>
        <Field data-invalid={!!errors.url}>
          <FieldLabel htmlFor="server-url">URL</FieldLabel>
          <Input
            id="server-url"
            type="url"
            placeholder="https://example.com/mcp"
            aria-invalid={!!errors.url}
            {...form.register("url")}
          />
          <FieldError errors={[errors.url]} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="server-auth">Authentication</FieldLabel>
            <NativeSelect id="server-auth" {...form.register("authType")}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </NativeSelect>
          </Field>
          <Field data-invalid={!!errors.timeoutMs}>
            <FieldLabel htmlFor="server-timeout">Timeout (ms)</FieldLabel>
            <Input
              id="server-timeout"
              type="number"
              aria-invalid={!!errors.timeoutMs}
              {...form.register("timeoutMs", { valueAsNumber: true })}
            />
            <FieldError errors={[errors.timeoutMs]} />
          </Field>
        </div>
        {authType === "header" && (
          <Field data-invalid={!!errors.authHeaderName}>
            <FieldLabel htmlFor="server-header">Header name</FieldLabel>
            <Input
              id="server-header"
              placeholder="X-API-Key"
              aria-invalid={!!errors.authHeaderName}
              {...form.register("authHeaderName")}
            />
            <FieldError errors={[errors.authHeaderName]} />
          </Field>
        )}
        {authType !== "none" && (
          <Field data-invalid={!!errors.credential}>
            <FieldLabel htmlFor="server-credential">
              {authType === "bearer" ? "Bearer token" : "Header value"}
            </FieldLabel>
            <Input
              id="server-credential"
              type="password"
              autoComplete="off"
              placeholder={editing?.hasCredential ? "•••••••• stored - leave blank to keep" : ""}
              aria-invalid={!!errors.credential}
              {...form.register("credential")}
            />
            <FieldDescription>
              Write-only: encrypted on the gateway, never shown again.
            </FieldDescription>
            <FieldError errors={[errors.credential]} />
          </Field>
        )}
        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving and checking…" : editing ? "Save" : "Add server"}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}
