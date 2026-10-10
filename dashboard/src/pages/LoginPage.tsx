import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { errorMessage } from "@/api/client";
import { useLogin, useMe } from "@/api/hooks";
import { AuthCard } from "@/components/AuthCard";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { safeNext } from "@/lib/urls";

const schema = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
type Values = z.infer<typeof schema>;

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });
  const { errors } = form.formState;

  if (me.data) return <Navigate to={next} replace />;

  const onSubmit = form.handleSubmit((values) =>
    login.mutate(values, { onSuccess: () => navigate(next, { replace: true }) }),
  );

  return (
    <AuthCard title="Log in" description="Use the email your admin invited.">
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={!!errors.email}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              aria-invalid={!!errors.email}
              {...form.register("email")}
            />
            <FieldError errors={[errors.email]} />
          </Field>
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              {...form.register("password")}
            />
            <FieldError errors={[errors.password]} />
          </Field>
          <FormError message={login.isError ? errorMessage(login.error) : null} />
          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? "Logging in…" : "Log in"}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
