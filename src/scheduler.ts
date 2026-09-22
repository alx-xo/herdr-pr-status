import type { Config } from './format';
import type { Workspace } from './herdr';

interface Entry {
  workspace: Workspace;
  identity?: string;
  completed?: number;
  retryAt: number;
  version: number;
  pending: boolean;
}
/** FIFO pending work, completion-relative deadlines, and versioned local observations. */
export class Scheduler {
  private serviceFailures = 0;
  private serviceRetryAt = 0;
  private rateLimitUntil = 0;
  constructor(private readonly random: () => number = Math.random) {}
  get nextRetryAt(): number { return Math.max(this.serviceRetryAt, this.rateLimitUntil); }
  canRefresh(now: number, manual = false): boolean {
    return now >= this.rateLimitUntil && (manual || now >= this.serviceRetryAt);
  }
  serviceFailure(now: number, knownRetryAt?: number) {
    // Equal jitter: 15–30s initially, doubling to a 150–300s ceiling.
    const ceiling = Math.min(300000, 30000 * 2 ** Math.min(this.serviceFailures++, 4));
    this.serviceRetryAt = now + Math.floor(ceiling * (0.5 + this.random() / 2));
    if (this.flight) this.flight.serviceRetry = true;
    if (knownRetryAt !== undefined) this.rateLimitUntil = Math.max(this.rateLimitUntil, knownRetryAt);
  }
  serviceSuccess() {
    this.serviceFailures = 0;
    this.serviceRetryAt = 0;
    // Successful work cannot erase a still-known cooldown.
  }
  readonly entries = new Map<string, Entry>();
  focused?: string;
  focusVersion = 0;
  private checks = new Set<string>();
  private flight?: { id: string; entry: Entry; version: number; serviceRetry?: true };
  focus(id: string) {
    if (id === this.focused) return;
    this.focusVersion++;
    if (this.focused) this.checks.add(this.focused);
    this.checks.add(id);
    this.focused = id;
  }
  reconcile(workspaces: Workspace[], focusVersion = this.focusVersion) {
    const ids = new Set(workspaces.map(w => w.workspace_id));
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
    for (const workspace of workspaces) {
      const entry = this.entries.get(workspace.workspace_id);
      if (entry) entry.workspace = workspace;
      else {
        this.entries.set(workspace.workspace_id, { workspace, retryAt: 0, version: 0, pending: true });
        this.checks.add(workspace.workspace_id);
      }
    }
    const focused = workspaces.find(w => w.focused === true);
    if (focused && focusVersion === this.focusVersion) this.focus(focused.workspace_id);
    else if (this.focused && !ids.has(this.focused)) this.focused = undefined;
  }
  localTargets(): Workspace[] {
    if (this.focused) this.checks.add(this.focused);
    const ids = [...this.checks]; this.checks.clear();
    return ids.flatMap(id => this.entries.has(id) ? [this.entries.get(id)!.workspace] : []);
  }
  observe(id: string, identity: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.identity !== undefined && entry.identity !== identity) {
      entry.version++;
      entry.pending = true;
    }
    entry.identity = identity;
  }
  private interval(id: string, config: Config) {
    return (id === this.focused ? config.activePollSeconds : config.pollSeconds) * 1000;
  }
  take(now: number, config: Config): Workspace | undefined {
    if (this.flight || !this.canRefresh(now)) return;
    for (const [id, entry] of this.entries) {
      if (now < entry.retryAt) continue;
      if (!entry.pending && entry.completed !== undefined && now < entry.completed + this.interval(id, config)) continue;
      entry.pending = false;
      this.flight = { id, entry, version: entry.version };
      return entry.workspace;
    }
  }
  /** The lock/preflight may have waited: consume only the identity actually queried. */
  consume(id: string, identity: string): boolean {
    const flight = this.flight;
    if (!flight || flight.id !== id || this.entries.get(id) !== flight.entry) return false;
    this.observe(id, identity);
    flight.version = flight.entry.version;
    flight.entry.pending = false;
    return true;
  }
  requeue(id: string) {
    const entry = this.entries.get(id);
    if (entry) entry.pending = true;
  }
  complete(now: number, config: Config, failed: boolean) {
    const flight = this.flight; this.flight = undefined;
    if (!flight || this.entries.get(flight.id) !== flight.entry) return;
    const entry = flight.entry;
    entry.completed = now;
    // A transient failure is pending retry work, not a completed periodic poll.
    // The shared service deadline (including explicit cooldown) gates eligibility.
    const serviceRetry = failed && flight.serviceRetry === true;
    entry.pending ||= serviceRetry || flight.version !== entry.version;
    entry.retryAt = failed && !serviceRetry ? now + this.interval(flight.id, config) : 0;
    // Move completed work to the tail so branch churn cannot starve other workspaces.
    this.entries.delete(flight.id); this.entries.set(flight.id, entry);
  }
}
