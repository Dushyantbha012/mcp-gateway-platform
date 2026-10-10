import { z } from "zod";

/** Mirrors the gateway's rule (MIN_PASSWORD_LENGTH in gateway/src/crypto/passwords.ts). */
export const MIN_PASSWORD_LENGTH = 12;

export const newPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`)
  .max(256, "At most 256 characters");

/** New password + confirmation, as used by the invite page and change-password dialog. */
export const passwordPair = z
  .object({ password: newPassword, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });
