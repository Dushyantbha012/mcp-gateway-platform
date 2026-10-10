import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router";
import type { z } from "zod";
import { api, errorMessage } from "@/api/client";
import { useAcceptInvite } from "@/api/hooks";
import { AuthCard } from "@/components/AuthCard";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MIN_PASSWORD_LENGTH, passwordPair } from "@/lib/validation";

type Values = z.infer<typeof passwordPair>;

interface InviteInfo {
  email: string;
  name: string;
  isReset: boolean;
}

/** /invite/:token - the link an admin copied from the Team page. */
export function InvitePage() {
  const token = useParams().token ?? "";
  const navigate = useNavigate();
  const info = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InviteInfo>(`/auth/invites/${encodeURIComponent(token)}`),
    retry: false,
    staleTime: Infinity,
  });
  const accept = useAcceptInvite(token);
  const form = useForm<Values>({
    resolver: zodResolver(passwordPair),
    defaultValues: { password: "", confirm: "" },
  });
  const { errors } = form.formState;

  if (info.isPending) return <AuthCard title="Checking your invite…">{null}</AuthCard>;
  if (info.isError) {
    return (
      <AuthCard title="Invite not valid">
        <FormError message="This invite link is invalid, already used, or expired. Ask your admin for a new one." />
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit(({ password }) =>
    accept.mutate(password, { onSuccess: () => navigate("/servers", { replace: true }) }),
  );

  return (
    <AuthCard
      title={info.data.isReset ? "Reset your password" : `Welcome, ${info.data.name}`}
      description={
        <>
          Set a password for <strong>{info.data.email}</strong>.
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          {/* Lets password managers save the right username. */}
          <input type="hidden" autoComplete="username" value={info.data.email} readOnly />
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="password">New password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              {...form.register("password")}
            />
            <FieldDescription>At least {MIN_PASSWORD_LENGTH} characters.</FieldDescription>
            <FieldError errors={[errors.password]} />
          </Field>
          <Field data-invalid={!!errors.confirm}>
            <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirm}
              {...form.register("confirm")}
            />
            <FieldError errors={[errors.confirm]} />
          </Field>
          <FormError message={accept.isError ? errorMessage(accept.error) : null} />
          <Button type="submit" disabled={accept.isPending}>
            {accept.isPending ? "Saving…" : "Set password and continue"}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
