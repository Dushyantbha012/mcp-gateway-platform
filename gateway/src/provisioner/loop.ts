import type { Db } from "../db/db.js";
import type { Store } from "../db/schema.js";
import { pendingStores } from "../db/stores.js";
import { log } from "../logger.js";

/** What the loop works on: a store or a hosted server row. */
type Row = { id: string; slug: string };

export interface Reconciles<T extends Row = Store> {
  reconcile(row: T): Promise<unknown>;
}

/**
 * Runs the reconciler over every store with work left: on a timer, and at
 * once when `trigger()` is called (the API's NOTIFY). Up to `concurrency`
 * stores are worked on at a time - provisioning one store is mostly waiting
 * on pods, so several go in parallel - and a store is never reconciled by
 * two passes at once.
 */
export class ProvisionerLoop<T extends Row = Store> {
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private scanning?: Promise<void>;
  private rescan = false;

  constructor(
    private readonly db: Db,
    private readonly reconciler: Reconciles<T>,
    private readonly opts: {
      tickMs: number;
      concurrency: number;
      /** Rows with work left, oldest first; default: stores. */
      pending?: (db: Db, limit: number) => Promise<T[]>;
    },
  ) {}

  start(): void {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.trigger();
      this.timer = setTimeout(tick, this.opts.tickMs);
    };
    tick();
  }

  /** Look for work now. Coalesces: a trigger during a scan causes one more scan. */
  trigger(): void {
    if (this.stopped) return;
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = this.scan()
      .catch((err) => log("error", "provisioner scan failed", { error: String(err) }))
      .finally(() => {
        this.scanning = undefined;
        if (this.rescan) {
          this.rescan = false;
          this.trigger();
        }
      });
  }

  private async scan(): Promise<void> {
    const free = this.opts.concurrency - this.inFlight.size;
    if (free <= 0) return;
    const pending =
      this.opts.pending ?? (pendingStores as unknown as (db: Db, limit: number) => Promise<T[]>);
    const rows = await pending(this.db, this.opts.concurrency * 4);
    for (const store of rows.filter((s) => !this.inFlight.has(s.id)).slice(0, free)) {
      const run = this.reconciler
        .reconcile(store)
        .then(() => undefined)
        .catch((err) => log("error", "reconcile crashed", { slug: store.slug, error: String(err) }))
        .finally(() => {
          this.inFlight.delete(store.id);
        });
      this.inFlight.set(store.id, run);
    }
  }

  /** Waits for whatever is running; for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.scanning || this.inFlight.size) {
      await this.scanning;
      await Promise.all(this.inFlight.values());
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.idle();
  }
}
