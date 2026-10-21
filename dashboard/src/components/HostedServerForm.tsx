import { zodResolver } from "@hookform/resolvers/zod";
import { Lock, Plus, Trash2 } from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useSaveHosted } from "@/api/hooks";
import type { Hosted } from "@/api/types";
import { FormError } from "@/components/FormError";
import { NativeSelect } from "@/components/NativeSelect";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  hostedDefaults,
  hostedFormSchema,
  MAX_ENV,
  toHostedInput,
  toHostedUpdate,
  type HostedFormValues,
} from "@/pages/hostedForm";

/**
 * Run an MCP server from a container image (create, or edit `hosted`). The
 * provisioner gives it its own namespace; only the gateway can reach it.
 */
export function HostedServerForm(props: {
  hosted?: Hosted;
  imageAllowlist: string[];
  onClose: () => void;
}) {
  const editing = props.hosted;
  const save = useSaveHosted();
  const form = useForm<HostedFormValues>({
    resolver: zodResolver(hostedFormSchema),
    defaultValues: hostedDefaults(editing),
  });
  const env = useFieldArray({ control: form.control, name: "env" });
  const { errors } = form.formState;
  const transport = form.watch("transport");
  const isHttp = transport === "http";

  const onSubmit = form.handleSubmit((values) => {
    const input = editing ? toHostedUpdate(values, editing) : toHostedInput(values);
    if (editing && Object.keys(input).length === 0) return props.onClose();
    save.mutate(
      { id: editing?.id, input },
      {
        onSuccess: (saved) => {
          toast.success(
            saved.status === "provisioning"
              ? `${saved.name} is being ${editing ? "redeployed" : "deployed"}`
              : `${saved.name} saved`,
          );
          props.onClose();
        },
      },
    );
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <div className="grid grid-cols-2 gap-4">
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="hosted-name">Name</FieldLabel>
            <Input id="hosted-name" aria-invalid={!!errors.name} {...form.register("name")} />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.slug}>
            <FieldLabel htmlFor="hosted-slug">Slug</FieldLabel>
            <Input
              id="hosted-slug"
              placeholder="thinking"
              disabled={!!editing}
              aria-invalid={!!errors.slug}
              {...form.register("slug")}
            />
            <FieldError errors={[errors.slug]} />
          </Field>
        </div>
        <Field data-invalid={!!errors.image}>
          <FieldLabel htmlFor="hosted-image">Image</FieldLabel>
          <Input
            id="hosted-image"
            placeholder="mcp/sequentialthinking@sha256:…"
            spellCheck={false}
            aria-invalid={!!errors.image}
            {...form.register("image")}
          />
          <FieldDescription>
            Pin a version tag or a digest (<code>:latest</code> is refused).
            {props.imageAllowlist.length > 0 && (
              <>
                {" "}
                Allowed:{" "}
                {props.imageAllowlist.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ", "}
                    <code>{p}</code>
                  </span>
                ))}
              </>
            )}
          </FieldDescription>
          <FieldError errors={[errors.image]} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="hosted-transport">Transport</FieldLabel>
            <NativeSelect
              id="hosted-transport"
              disabled={!!editing}
              {...form.register("transport")}
            >
              <option value="stdio">stdio (bridged)</option>
              <option value="http">Streamable HTTP</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="hosted-libc">Bridge build</FieldLabel>
            <NativeSelect id="hosted-libc" disabled={isHttp} {...form.register("libc")}>
              <option value="glibc">glibc (Debian, Ubuntu)</option>
              <option value="musl">musl (Alpine)</option>
            </NativeSelect>
          </Field>
        </div>
        <Field data-invalid={!!errors.command}>
          <FieldLabel htmlFor="hosted-command">
            Command
            {isHttp && <span className="font-normal text-muted-foreground"> (optional)</span>}
          </FieldLabel>
          <Input
            id="hosted-command"
            placeholder={isHttp ? "the image's own entrypoint" : "node dist/index.js"}
            spellCheck={false}
            aria-invalid={!!errors.command}
            {...form.register("command")}
          />
          <FieldDescription>
            {isHttp
              ? "Overrides the image's entrypoint when set."
              : "Runs under the bridge, which serves it to the gateway over HTTP."}
          </FieldDescription>
          <FieldError errors={[errors.command]} />
        </Field>
        {isHttp && (
          <div className="grid grid-cols-3 gap-4">
            <Field data-invalid={!!errors.port}>
              <FieldLabel htmlFor="hosted-port">Port</FieldLabel>
              <Input
                id="hosted-port"
                type="number"
                aria-invalid={!!errors.port}
                {...form.register("port", { valueAsNumber: true })}
              />
              <FieldError errors={[errors.port]} />
            </Field>
            <Field data-invalid={!!errors.path} className="col-span-2">
              <FieldLabel htmlFor="hosted-path">Path</FieldLabel>
              <Input id="hosted-path" aria-invalid={!!errors.path} {...form.register("path")} />
              <FieldError errors={[errors.path]} />
            </Field>
            <Field data-invalid={!!errors.authTokenEnv} className="col-span-3">
              <FieldLabel htmlFor="hosted-token-env">
                Auth token variable{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input
                id="hosted-token-env"
                placeholder="MCP_AUTH_TOKEN"
                spellCheck={false}
                aria-invalid={!!errors.authTokenEnv}
                {...form.register("authTokenEnv")}
              />
              <FieldDescription>
                If the image requires a bearer token: the provisioner generates one, passes it in
                this variable, and the gateway sends it.
              </FieldDescription>
              <FieldError errors={[errors.authTokenEnv]} />
            </Field>
          </div>
        )}

        <fieldset className="space-y-2">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-medium">Environment</legend>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={env.fields.length >= MAX_ENV}
              onClick={() => env.append({ name: "", value: "", secret: false, stored: false })}
            >
              <Plus /> Add variable
            </Button>
          </div>
          {env.fields.length === 0 && (
            <p className="text-xs text-muted-foreground">No variables.</p>
          )}
          {env.fields.map((row, i) => {
            const rowErrors = errors.env?.[i];
            const secret = form.watch(`env.${i}.secret`);
            const stored = row.stored && secret;
            return (
              <div
                key={row.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-start gap-1.5 sm:gap-2"
              >
                <div>
                  <Input
                    aria-label={`Variable ${i + 1} name`}
                    placeholder="NAME"
                    spellCheck={false}
                    readOnly={stored}
                    aria-invalid={!!rowErrors?.name}
                    {...form.register(`env.${i}.name`)}
                  />
                  <FieldError errors={[rowErrors?.name]} />
                </div>
                <div>
                  <Input
                    aria-label={`Variable ${i + 1} value`}
                    type={secret ? "password" : "text"}
                    autoComplete="off"
                    placeholder={stored ? "•••••••• stored - leave blank to keep" : "value"}
                    aria-invalid={!!rowErrors?.value}
                    {...form.register(`env.${i}.value`)}
                  />
                  <FieldError errors={[rowErrors?.value]} />
                </div>
                <label className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    checked={secret}
                    aria-label={`Variable ${i + 1} secret`}
                    onCheckedChange={(on) =>
                      form.setValue(`env.${i}.secret`, on, { shouldDirty: true })
                    }
                  />
                  <Lock className="size-3.5" aria-hidden />{" "}
                  <span className="hidden sm:inline">Secret</span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove variable ${i + 1}`}
                  onClick={() => env.remove(i)}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
          <FieldDescription>
            Secret values go to a Kubernetes Secret, never to the database, and are never shown
            again.
          </FieldDescription>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="hosted-egress">Outbound network</FieldLabel>
            <NativeSelect id="hosted-egress" {...form.register("egress")}>
              <option value="none">None (DNS only)</option>
              <option value="internet">Internet (no private ranges)</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="hosted-size">Size</FieldLabel>
            <NativeSelect id="hosted-size" {...form.register("size")}>
              <option value="small">Small (0.5 CPU, 256 MiB)</option>
              <option value="medium">Medium (1 CPU, 512 MiB)</option>
            </NativeSelect>
          </Field>
        </div>

        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save" : "Deploy server"}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}
