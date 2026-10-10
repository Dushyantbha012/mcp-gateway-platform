import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { errorMessage } from "@/api/client";
import { useCreateKey, useMeta, useRevokeKey, useUserKeys } from "@/api/hooks";
import type { NewApiKey } from "@/api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyField } from "@/components/CopyField";
import { FormError } from "@/components/FormError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/format";
import { claudeCodeCommand } from "@/lib/mcp";

/**
 * Shows a freshly created key - the only time the plaintext exists outside
 * the gateway's response. Closing the dialog drops it from memory.
 */
export function NewKeyDialog({ created, onClose }: { created: NewApiKey; onClose: () => void }) {
  const meta = useMeta();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>API key "{created.name}" created</DialogTitle>
          <DialogDescription>
            Copy it now. It's stored only as a hash, so it can't be shown again - if you lose it,
            revoke it and create another.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <CopyField label="New API key" value={created.key} />
          {meta.data?.mcpUrl && (
            <div className="space-y-1">
              <p className="font-medium">Claude Code, with this key</p>
              <CopyField
                label="Claude Code command"
                value={claudeCodeCommand(meta.data.mcpUrl, created.key)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I've copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const nameSchema = z.object({ name: z.string().trim().min(1, "Give the key a name").max(100) });

/** A user's API keys: create (shown once), list, revoke. `userId` "me" = your own. */
export function KeyManager({ userId, ownerLabel }: { userId: string; ownerLabel?: string }) {
  const list = useUserKeys(userId);
  const create = useCreateKey(userId);
  const revoke = useRevokeKey(userId);
  const [created, setCreated] = useState<NewApiKey | null>(null);
  const form = useForm<{ name: string }>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: "" },
  });

  const onSubmit = form.handleSubmit(({ name }) =>
    create.mutate(name, {
      onSuccess: (key) => {
        form.reset();
        setCreated(key);
      },
    }),
  );

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} noValidate className="flex items-start gap-2">
        <Field className="max-w-xs" data-invalid={!!form.formState.errors.name}>
          <FieldLabel htmlFor={`key-name-${userId}`} className="sr-only">
            Key name
          </FieldLabel>
          <Input
            id={`key-name-${userId}`}
            placeholder="Key name, e.g. laptop"
            aria-invalid={!!form.formState.errors.name}
            {...form.register("name")}
          />
          <FieldError errors={[form.formState.errors.name]} />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          {ownerLabel ? `Issue key for ${ownerLabel}` : "Create API key"}
        </Button>
      </form>
      <FormError message={create.isError ? errorMessage(create.error) : null} />
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell>
                  <code className="text-xs">{key.prefix}…</code>
                </TableCell>
                <TableCell>{timeAgo(key.createdAt)}</TableCell>
                <TableCell>{timeAgo(key.lastUsedAt)}</TableCell>
                <TableCell>
                  {key.revokedAt ? (
                    <Badge variant="secondary">Revoked {timeAgo(key.revokedAt)}</Badge>
                  ) : (
                    <Badge className="border-transparent bg-emerald-100 text-emerald-800">
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!key.revokedAt && (
                    <ConfirmButton
                      title={`Revoke "${key.name}"?`}
                      description="Any MCP client using it is rejected on its very next call. This can't be undone."
                      confirmLabel="Revoke"
                      onConfirm={() =>
                        revoke.mutate(key.id, {
                          onSuccess: () => toast.success(`Key "${key.name}" revoked`),
                          onError: (err) => toast.error(errorMessage(err)),
                        })
                      }
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No API keys yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {created && <NewKeyDialog created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}
