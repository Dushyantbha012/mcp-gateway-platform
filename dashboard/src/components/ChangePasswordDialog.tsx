import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { errorMessage } from "@/api/client";
import { useChangePassword } from "@/api/hooks";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { passwordPair } from "@/lib/validation";

const schema = z.intersection(
  z.object({ currentPassword: z.string().min(1, "Enter your current password") }),
  passwordPair,
);
type Values = z.infer<typeof schema>;

export function ChangePasswordDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const change = useChangePassword();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", password: "", confirm: "" },
  });
  const { errors } = form.formState;

  const close = (open: boolean) => {
    if (!open) {
      form.reset();
      change.reset();
    }
    props.onOpenChange(open);
  };

  const onSubmit = form.handleSubmit((v) =>
    change.mutate(
      { currentPassword: v.currentPassword, newPassword: v.password },
      {
        onSuccess: () => {
          toast.success("Password changed. Other sessions were logged out.");
          close(false);
        },
      },
    ),
  );

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            You'll stay logged in here; other sessions are logged out.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.currentPassword}>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                {...form.register("currentPassword")}
              />
              <FieldError errors={[errors.currentPassword]} />
            </Field>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                {...form.register("password")}
              />
              <FieldError errors={[errors.password]} />
            </Field>
            <Field data-invalid={!!errors.confirm}>
              <FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                {...form.register("confirm")}
              />
              <FieldError errors={[errors.confirm]} />
            </Field>
            <FormError message={change.isError ? errorMessage(change.error) : null} />
            <DialogFooter>
              <Button type="submit" disabled={change.isPending}>
                Change password
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
