import { createHash } from "node:crypto";
import type { SecretBox } from "../crypto/secretBox.js";
import type { McpServer } from "../db/schema.js";
import { UpstreamConnection, type UpstreamConfig } from "./connection.js";

/**
 * Owns one UpstreamConnection per server. The DB row is the source of truth:
 * every lookup passes the current row, and if anything that affects the
 * connection changed (URL, credential, timeout) the old session is closed and
 * a new one made. That's what makes an admin's edit take effect immediately,
 * on every gateway replica, without any cross-replica messaging.
 */
export class UpstreamRegistry {
  private readonly entries = new Map<string, { fingerprint: string; conn: UpstreamConnection }>();

  constructor(
    private readonly box: SecretBox,
    private readonly opts: { maxResultBytes: number },
  ) {}

  get(server: McpServer): UpstreamConnection {
    const fingerprint = fingerprintOf(server);
    const existing = this.entries.get(server.id);
    if (existing?.fingerprint === fingerprint) return existing.conn;
    if (existing) void existing.conn.close();
    const conn = new UpstreamConnection(this.configFor(server), this.opts);
    this.entries.set(server.id, { fingerprint, conn });
    return conn;
  }

  /** Closes connections for servers that were deleted or disabled. */
  async retain(activeIds: Set<string>): Promise<void> {
    const gone = [...this.entries].filter(([id]) => !activeIds.has(id));
    for (const [id] of gone) this.entries.delete(id);
    await Promise.all(gone.map(([, entry]) => entry.conn.close()));
  }

  async closeAll(): Promise<void> {
    await this.retain(new Set());
  }

  private configFor(server: McpServer): UpstreamConfig {
    const headers: Record<string, string> = {};
    if (server.auth_type !== "none" && server.credential_ciphertext) {
      // Decrypted only here, only in memory, only to build outgoing headers.
      const credential = this.box.decrypt(server.credential_ciphertext, server.id);
      if (server.auth_type === "bearer") headers.Authorization = `Bearer ${credential}`;
      else headers[server.auth_header_name!] = credential;
    }
    return {
      id: server.id,
      slug: server.slug,
      url: server.url,
      headers,
      timeoutMs: server.timeout_ms,
    };
  }
}

function fingerprintOf(server: McpServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        server.slug,
        server.url,
        server.auth_type,
        server.auth_header_name,
        server.credential_ciphertext?.toString("base64") ?? null,
        server.timeout_ms,
      ]),
    )
    .digest("hex");
}
