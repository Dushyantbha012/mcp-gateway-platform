import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for upstream credentials stored in Postgres. The key
 * comes from the `gateway-encryption-key` Secret and never touches the DB.
 *
 * Layout: version(1) | iv(12) | tag(16) | ciphertext. The version byte leaves
 * room for key rotation. Callers pass the owning row's id as associated data,
 * so a ciphertext copied onto another server's row fails to decrypt instead
 * of handing that server someone else's credential.
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  encrypt(plaintext: string, aad: string): Buffer;
  decrypt(box: Buffer, aad: string): string;
}

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("Encryption key must be 32 bytes, base64-encoded");
  }
  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(box, aad) {
      if (box.length < 1 + IV_BYTES + TAG_BYTES || box[0] !== VERSION) {
        throw new Error("Unrecognised credential format");
      }
      const iv = box.subarray(1, 1 + IV_BYTES);
      const tag = box.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      const ciphertext = box.subarray(1 + IV_BYTES + TAG_BYTES);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
