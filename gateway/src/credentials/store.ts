/**
 * Where upstream credentials (the GitHub token, the WooCommerce MCP bearer
 * token, ...) live. In production that is one Kubernetes Secret per upstream
 * server in a namespace of its own (see k8s.ts); Postgres only records
 * *whether* a server has a credential, never the value.
 */
export interface StoredCredential {
  value: string;
  /** Changes whenever the value does (the Secret's resourceVersion). */
  version: string;
}

export interface CredentialStore {
  get(serverId: string): Promise<StoredCredential | null>;
  /** Creates or replaces. */
  put(serverId: string, value: string): Promise<void>;
  /** Deleting something that doesn't exist is not an error. */
  delete(serverId: string): Promise<void>;
  /** Every stored credential's server id, with its age, for the orphan sweep. */
  list(): Promise<{ serverId: string; createdAt: Date }[]>;
}

/** In-process store for tests and for running the gateway outside Kubernetes. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, { value: string; version: number; createdAt: Date }>();
  private counter = 0;

  async get(serverId: string) {
    const e = this.entries.get(serverId);
    return e ? { value: e.value, version: String(e.version) } : null;
  }
  async put(serverId: string, value: string) {
    const existing = this.entries.get(serverId);
    this.entries.set(serverId, {
      value,
      version: ++this.counter,
      createdAt: existing?.createdAt ?? new Date(),
    });
  }
  async delete(serverId: string) {
    this.entries.delete(serverId);
  }
  async list() {
    return [...this.entries].map(([serverId, e]) => ({ serverId, createdAt: e.createdAt }));
  }
}
