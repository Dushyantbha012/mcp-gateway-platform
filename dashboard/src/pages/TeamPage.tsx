import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronRight, UserPlus } from "lucide-react";
import { Fragment, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { errorMessage } from "@/api/client";
import { useInviteUser, useMe, useReinvite, useUpdateUser, useUsers } from "@/api/hooks";
import type { Invite, Role, User } from "@/api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyField } from "@/components/CopyField";
import { FormError } from "@/components/FormError";
import { KeyManager } from "@/components/KeyManager";
import { NativeSelect } from "@/components/NativeSelect";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateTime, timeAgo } from "@/lib/format";
import { absoluteInviteUrl } from "@/lib/urls";

function InviteLinkDialog(props: { title: string; invite: Invite; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            Send this link to them yourself (the gateway doesn't send email). It works once, until{" "}
            {dateTime(props.invite.inviteExpiresAt)}, and is shown only now.
          </DialogDescription>
        </DialogHeader>
        <CopyField label="Invite link" value={absoluteInviteUrl(props.invite.inviteUrl)} />
        <DialogFooter>
          <Button onClick={props.onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const inviteSchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  email: z.email("Enter a valid email"),
  role: z.enum(["member", "admin"]),
});
type InviteValues = z.infer<typeof inviteSchema>;

function InviteDialog({ onClose }: { onClose: () => void }) {
  const invite = useInviteUser();
  const [result, setResult] = useState<(User & Invite) | null>(null);
  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { name: "", email: "", role: "member" },
  });
  const { errors } = form.formState;

  if (result) {
    return <InviteLinkDialog title={`${result.name} invited`} invite={result} onClose={onClose} />;
  }
  const onSubmit = form.handleSubmit((values) => invite.mutate(values, { onSuccess: setResult }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>
            You'll get a one-time link for them to set a password. Members use tools; admins also
            manage servers, the team and the audit log.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="invite-name">Name</FieldLabel>
              <Input id="invite-name" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                aria-invalid={!!errors.email}
                {...form.register("email")}
              />
              <FieldError errors={[errors.email]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
              <NativeSelect id="invite-role" {...form.register("role")}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </NativeSelect>
            </Field>
            <FormError message={invite.isError ? errorMessage(invite.error) : null} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={invite.isPending}>
                Create invite link
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserStatus({ user }: { user: User }) {
  if (user.disabledAt) return <Badge variant="secondary">Disabled</Badge>;
  if (!user.hasPassword)
    return (
      <Badge className="border-transparent bg-warning-soft text-warning">Invite pending</Badge>
    );
  return <Badge className="border-transparent bg-success-soft text-success">Active</Badge>;
}

function UserRow({ user, isSelf }: { user: User; isSelf: boolean }) {
  const update = useUpdateUser();
  const reinvite = useReinvite();
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const fail = (err: unknown) => toast.error(errorMessage(err));
  const change = (changes: { role?: Role; disabled?: boolean }, done: string) =>
    update.mutate(
      { id: user.id, changes },
      { onSuccess: () => toast.success(done), onError: fail },
    );

  return (
    <Fragment>
      <TableRow data-testid={`user-${user.email}`}>
        <TableCell data-label="User">
          <button
            type="button"
            className="flex items-center gap-1 text-left"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={`API keys of ${user.email}`}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            <span>
              <span className="block font-medium">
                {user.name}
                {isSelf && <span className="text-muted-foreground"> (you)</span>}
              </span>
              <span className="block text-xs text-muted-foreground">{user.email}</span>
            </span>
          </button>
        </TableCell>
        <TableCell data-label="Role">
          <NativeSelect
            aria-label={`Role of ${user.email}`}
            className="w-28"
            value={user.role}
            disabled={isSelf || update.isPending}
            onChange={(e) =>
              change({ role: e.target.value as Role }, `${user.name} is now ${e.target.value}`)
            }
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </NativeSelect>
        </TableCell>
        <TableCell data-label="Status">
          <UserStatus user={user} />
        </TableCell>
        <TableCell data-label="Joined">{timeAgo(user.createdAt)}</TableCell>
        <TableCell className="flex-wrap justify-end space-x-2 text-right md:whitespace-nowrap">
          {!user.disabledAt && (
            <Button
              variant="outline"
              size="sm"
              disabled={reinvite.isPending}
              onClick={() => reinvite.mutate(user.id, { onSuccess: setInvite, onError: fail })}
            >
              {user.hasPassword ? "Reset password" : "New invite link"}
            </Button>
          )}
          {!isSelf &&
            (user.disabledAt ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => change({ disabled: false }, `${user.name} enabled`)}
              >
                Enable
              </Button>
            ) : (
              <ConfirmButton
                title={`Disable ${user.name}?`}
                description="They're logged out of the dashboard and all their API keys stop working immediately. You can enable them again later."
                confirmLabel="Disable"
                onConfirm={() => change({ disabled: true }, `${user.name} disabled`)}
              >
                Disable
              </ConfirmButton>
            ))}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/30 p-4">
            <KeyManager userId={user.id} ownerLabel={user.name} />
          </TableCell>
        </TableRow>
      )}
      {invite && (
        <InviteLinkDialog
          title={
            user.hasPassword
              ? `Password reset link for ${user.name}`
              : `New invite link for ${user.name}`
          }
          invite={invite}
          onClose={() => setInvite(null)}
        />
      )}
    </Fragment>
  );
}

export function TeamPage() {
  const { data: me } = useMe();
  const users = useUsers();
  const [inviting, setInviting] = useState(false);

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite members, change roles, disable accounts, and issue or revoke anyone's API keys."
        actions={
          <Button onClick={() => setInviting(true)}>
            <UserPlus /> Invite member
          </Button>
        }
      />
      {users.isError && <p role="alert">Couldn't load the team: {errorMessage(users.error)}</p>}
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <Table className="stack-table">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data?.map((user) => (
              <UserRow key={user.id} user={user} isSelf={user.id === me?.id} />
            ))}
          </TableBody>
        </Table>
      </div>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </>
  );
}
