import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLink, Loader2, Plus, RotateCcw, Store as StoreIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { errorMessage } from "@/api/client";
import { useCreateStore, useDeleteStore, useMe, useRetryStore, useStores } from "@/api/hooks";
import type { Store, StoreStatus } from "@/api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EmptyState } from "@/components/EmptyState";
import { FormError } from "@/components/FormError";
import { PageHeader } from "@/components/PageHeader";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS: Record<StoreStatus, { label: string; className: string }> = {
  provisioning: { label: "Provisioning", className: "bg-warning-soft text-warning" },
  ready: { label: "Ready", className: "bg-success-soft text-success" },
  failed: { label: "Failed", className: "bg-danger-soft text-destructive" },
  deleting: { label: "Deleting", className: "bg-muted text-muted-foreground" },
};

/** The provisioner's step names, as a person would say them. */
const STEP: Record<string, string> = {
  retry: "Retrying",
  namespace: "Creating namespace",
  secrets: "Generating secrets",
  resources: "Creating resources",
  mysql: "Starting MySQL",
  wordpress: "Starting WordPress",
  bootstrap: "Installing WooCommerce",
  mcp: "Starting MCP server",
  register: "Registering with the gateway",
  deleting: "Queued for deletion",
  "deleting-namespace": "Removing namespace",
};

function StoreStatusBadge({ status }: { status: StoreStatus }) {
  const { label, className } = STATUS[status];
  const busy = status === "provisioning" || status === "deleting";
  return (
    <Badge className={cn("gap-1 border-transparent", className)} data-status={status}>
      {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {label}
    </Badge>
  );
}

/** What's happening right now, or why it stopped. */
function Progress({ store }: { store: Store }) {
  if (store.status === "ready") {
    return (
      <span className="text-muted-foreground">
        Tools prefixed <code>{store.slug}__</code>
      </span>
    );
  }
  const step = store.step ? (STEP[store.step] ?? store.step) : "Queued";
  if (store.status === "failed") {
    return <span className="text-destructive">{store.reason ?? "Failed"}</span>;
  }
  return (
    <span>
      {step}
      {store.reason && <span className="block text-xs text-muted-foreground">{store.reason}</span>}
    </span>
  );
}

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Required")
    .max(100)
    .refine((n) => /[a-z]/i.test(n), "Use at least one letter"),
});
type CreateValues = z.infer<typeof createSchema>;

function CreateStoreDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateStore();
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "" },
  });
  const { errors } = form.formState;
  const onSubmit = form.handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: (store) => {
        toast.success(`${store.name} is being created`);
        onClose();
      },
    }),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a store</DialogTitle>
          <DialogDescription>
            A fresh WooCommerce store in its own namespace, with sample products. It takes a few
            minutes; its tools then appear in the gateway for the whole team.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="store-name">Store name</FieldLabel>
              <Input
                id="store-name"
                placeholder="Acme"
                autoFocus
                aria-invalid={!!errors.name}
                {...form.register("name")}
              />
              <FieldDescription>
                Also its tool prefix and address, e.g. “Acme” becomes <code>acme__list_orders</code>
                .
              </FieldDescription>
              <FieldError errors={[errors.name]} />
            </Field>
            <FormError message={create.isError ? errorMessage(create.error) : null} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                Create store
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StoreRow({ store, isSelf }: { store: Store; isSelf: boolean }) {
  const remove = useDeleteStore();
  const retry = useRetryStore();
  const fail = (err: unknown) => toast.error(errorMessage(err));

  return (
    <TableRow data-testid={`store-${store.slug}`}>
      <TableCell data-label="Store">
        <span className="block font-medium">
          {store.name}
          {store.kind === "default" && (
            <Badge variant="secondary" className="ml-2 align-middle">
              Default
            </Badge>
          )}
        </span>
        <code className="text-xs text-muted-foreground">{store.slug}</code>
      </TableCell>
      <TableCell data-label="Status">
        <StoreStatusBadge status={store.status} />
      </TableCell>
      <TableCell data-label="Progress" className="max-w-xs whitespace-normal text-sm">
        <Progress store={store} />
      </TableCell>
      <TableCell data-label="Storefront">
        {store.url && store.status === "ready" ? (
          <a
            href={store.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
          >
            {new URL(store.url).host} <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell data-label="Owner" className="text-sm">
        {store.owner?.email ?? <span className="text-muted-foreground">Helm</span>}
        {isSelf && <span className="text-muted-foreground"> (you)</span>}
      </TableCell>
      <TableCell data-label="Created">{timeAgo(store.createdAt)}</TableCell>
      <TableCell className="flex-wrap justify-end space-x-2 text-right md:whitespace-nowrap">
        {store.canManage && store.status === "failed" && (
          <Button
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() =>
              retry.mutate(store.id, {
                onSuccess: () => toast.success(`Retrying ${store.name}`),
                onError: fail,
              })
            }
          >
            <RotateCcw /> Retry
          </Button>
        )}
        {store.canManage && store.status !== "deleting" && (
          <ConfirmButton
            variant="ghost"
            title={`Delete ${store.name}?`}
            description={
              <>
                Its tools disappear for everyone, and the store - products, orders, customers and
                its database - is permanently deleted. This can't be undone.
              </>
            }
            confirmLabel="Delete store"
            disabled={remove.isPending}
            onConfirm={() =>
              remove.mutate(store.id, {
                onSuccess: () => toast.success(`Deleting ${store.name}`),
                onError: fail,
              })
            }
          >
            <Trash2 /> <span className="sr-only">Delete {store.name}</span>
          </ConfirmButton>
        )}
      </TableCell>
    </TableRow>
  );
}

export function StoresPage() {
  const { data: me } = useMe();
  const stores = useStores();
  const [creating, setCreating] = useState(false);
  const mine = stores.data?.stores.filter(
    (s) => s.kind === "provisioned" && s.owner?.id === me?.id,
  ).length;
  const atLimit = stores.data ? (mine ?? 0) >= stores.data.maxPerUser : false;

  return (
    <>
      <PageHeader
        title="Stores"
        description="WooCommerce stores the gateway serves. Each one runs isolated in its own namespace; its tools are named after it."
        actions={
          stores.data?.enabled && (
            <Button
              onClick={() => setCreating(true)}
              disabled={atLimit}
              title={atLimit ? `You can have ${stores.data.maxPerUser} stores` : undefined}
            >
              <Plus /> Create store
            </Button>
          )
        }
      />
      {stores.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
      {stores.isError && <p role="alert">Couldn't load stores: {errorMessage(stores.error)}</p>}
      {stores.data && stores.data.stores.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Storefront</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.data.stores.map((store) => (
                <StoreRow key={store.id} store={store} isSelf={store.owner?.id === me?.id} />
              ))}
            </TableBody>
          </Table>
          {stores.data.enabled && (
            <p className="mt-3 text-xs text-muted-foreground">
              You have {mine} of {stores.data.maxPerUser} stores.
            </p>
          )}
        </>
      )}
      {stores.data?.stores.length === 0 && (
        <EmptyState
          icon={StoreIcon}
          title="No stores yet."
          description={
            stores.data.enabled
              ? "Use “Create store” to spin one up."
              : "Store provisioning isn't enabled on this gateway."
          }
        />
      )}
      {creating && <CreateStoreDialog onClose={() => setCreating(false)} />}
    </>
  );
}
