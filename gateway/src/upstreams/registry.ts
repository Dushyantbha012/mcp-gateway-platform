import { createHash } from "node:crypto";
import type { CredentialStore, StoredCredential } from "../credentials/store.js";
import type { McpServer } from "../db/schema.js";
import { policyForServer, type SsrfPolicy } from "../security/ssrf.js";
import { UpstreamConnection, UpstreamError, type UpstreamConfig } from "./connection.js";

interface RegistryOptions {
  maxResultBytes: number;
  ssrf: SsrfPolicy;
  /**
   * How long a credential read from the credential store is reused. Keeps a
   * tool call from costing a Kubernetes API round-trip; it is also how long
   * another replica can keep using an old credential after an admin rotates it.
   */
  credentialTtlMs?: number;
}

/**
 * Owns one UpstreamConnection per server. The DB row (URL, auth type, timeout)
 * and the credential store (the secret itself) are the source of truth: every
 * lookup passes the current row, and if anything that affects the connection
 * changed the old session is closed and a new one made. That is what makes an
 * admin's edit take effect without any cross-replica messaging.
 */
export class UpstreamRegistry {
  private readonly entries = new Map<string, { fingerprint: string; conn: UpstreamConnection }>();
  private readonly credentials = new Map<string, { at: number; value: StoredCredential | null }>();

  constructor(
    private readonly store: CredentialStore,
    private readonly opts: RegistryOptions,
  ) {}

  async get(server: McpServer): Promise<UpstreamConnection> {
    const credential = server.auth_type === "none" ? null : await this.credential(server);
    const fingerprint = fingerprintOf(server, credential);
    const existing = this.entries.get(server.id);
    if (existing?.fingerprint === fingerprint) return existing.conn;
    if (existing) void existing.conn.close();
    const conn = new UpstreamConnection(this.configFor(server, credential), {
      ...this.opts,
      ssrf: policyForServer(this.opts.ssrf, server),
    });
    this.entries.set(server.id, { fingerprint, conn });
    return conn;
  }

  /** The credential was just written or removed here: don't serve a cached copy. */
  invalidate(id: string): void {
    this.credentials.delete(id);
  }

  /** Closes connections for servers that were deleted or disabled. */
  async retain(activeIds: Set<string>): Promise<void> {
    const gone = [...this.entries].filter(([id]) => !activeIds.has(id));
    for (const [id] of gone) this.entries.delete(id);
    for (const id of [...this.credentials.keys()])
      if (!activeIds.has(id)) this.credentials.delete(id);
    await Promise.all(gone.map(([, entry]) => entry.conn.close()));
  }

  /** Drops one server's session (it was disabled or deleted). */
  async forget(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    this.credentials.delete(id);
    await entry?.conn.close();
  }

  async closeAll(): Promise<void> {
    await this.retain(new Set());
  }

  private async credential(server: McpServer): Promise<StoredCredential> {
    const ttl = this.opts.credentialTtlMs ?? 5_000;
    const cached = this.credentials.get(server.id);
    let value: StoredCredential | null;
    if (cached && Date.now() - cached.at < ttl) {
      value = cached.value;
    } else {
      try {
        value = await this.store.get(server.id);
      } catch (err) {
        // Not the stored credential's fault and nothing secret in the message.
        throw new UpstreamError(
          "unreachable",
          `Upstream '${server.slug}' credential unavailable: ${(err as Error).message.slice(0, 160)}`,
        );
      }
      this.credentials.set(server.id, { at: Date.now(), value });
    }
    if (!value) {
      throw new UpstreamError(
        "unreachable",
        `Upstream '${server.slug}' has no stored credential; edit the server and enter it again`,
      );
    }
    return value;
  }

  private configFor(server: McpServer, credential: StoredCredential | null): UpstreamConfig {
    const headers: Record<string, string> = {};
    // The value lives only in memory, only to build outgoing headers.
    if (credential && server.auth_type === "bearer") {
      headers.Authorization = `Bearer ${credential.value}`;
    } else if (credential) {
      headers[server.auth_header_name!] = credential.value;
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

function fingerprintOf(server: McpServer, credential: StoredCredential | null): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        server.slug,
        server.url,
        server.auth_type,
        server.auth_header_name,
        credential?.version ?? null,
        server.timeout_ms,
        server.managed_by,
      ]),
    )
    .digest("hex");
}
