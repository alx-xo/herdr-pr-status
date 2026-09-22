import { realpath, stat } from 'node:fs/promises';
import type { Config } from './format';
import { discoverCheckout, type Workspace } from './herdr';
import type { Runner } from './process';
import { Scheduler } from './scheduler';

export async function localIdentity(workspace: Workspace, run: Runner): Promise<string> {
  const checkout = await discoverCheckout(workspace, run);
  if (!checkout.cwd) return JSON.stringify([null, checkout.skipped]);
  const root = await realpath(checkout.cwd);
  const info = await stat(root, { bigint: true });
  const gitDir = await realpath((await run(['git', 'rev-parse', '--absolute-git-dir'], root)).trim());
  const gitInfo = await stat(gitDir, { bigint: true });
  const branch = (await run(['git', 'branch', '--show-current'], root)).trim();
  return JSON.stringify([root, String(info.dev), String(info.ino), gitDir, String(gitInfo.dev), String(gitInfo.ino), branch]);
}

/** Access named checkout fields without exposing the opaque identity's layout. */
export function observedCheckout(identity: string): { root: string | null; branch?: string } {
  const [root, , , , , , branch] = JSON.parse(identity) as [string | null, unknown?, unknown?, unknown?, unknown?, unknown?, string?];
  return { root, branch: typeof branch === 'string' ? branch : undefined };
}

interface Options {
  scheduler: Scheduler;
  now?: () => number;
  active: () => boolean;
  load: () => Promise<Config>;
  list: () => Promise<Workspace[]>;
  local: (workspace: Workspace) => Promise<string>;
  refresh: (config: Config, workspace: Workspace) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  error: (error: unknown) => void;
  settled: (initial: boolean) => Promise<void>;
}
/** Local observation continues while the serialized remote lane is busy. */
export async function workspaceLoop(o: Options): Promise<void> {
  const now = o.now ?? Date.now;
  let config: Config | undefined;
  let remote: Promise<void> | undefined;
  let initialized = false;
  let retryAt = 0;
  const localRetry = new Map<string, number>();
  const drain = () => {
    if (remote || !config || !o.active()) return;
    const currentConfig = config;
    const workspace = o.scheduler.take(now(), currentConfig);
    if (!workspace) return;
    remote = (async () => {
      let failed = false;
      try { await o.refresh(currentConfig, workspace); }
      catch (error) { failed = true; o.error(error); }
      finally { o.scheduler.complete(now(), currentConfig, failed); }
      await o.settled(false);
    })().catch(o.error).finally(() => { remote = undefined; });
  };
  try {
    while (o.active()) {
      if (now() >= retryAt) {
        try {
          config = await o.load();
          const focusVersion = o.scheduler.focusVersion;
          const workspaces = await o.list();
          if (!o.active()) break;
          o.scheduler.reconcile(workspaces, focusVersion);
          for (const id of localRetry.keys()) if (!o.scheduler.entries.has(id)) localRetry.delete(id);
          const targets = new Map(o.scheduler.localTargets().map(w => [w.workspace_id, w]));
          for (const id of localRetry.keys()) {
            const entry = o.scheduler.entries.get(id);
            if (entry) targets.set(id, entry.workspace);
          }
          for (const workspace of targets.values()) {
            if (!o.active()) break;
            if (now() < (localRetry.get(workspace.workspace_id) ?? 0)) continue;
            try {
              o.scheduler.observe(workspace.workspace_id, await o.local(workspace));
              localRetry.delete(workspace.workspace_id);
            } catch (error) {
              localRetry.set(workspace.workspace_id, now() + 15000);
              o.error(error);
            }
          }
          if (!initialized) { initialized = true; await o.settled(true); }
        } catch (error) {
          config = undefined;
          retryAt = now() + 60000;
          o.error(error);
          await o.settled(false);
        }
      }
      drain();
      if (o.active()) await o.sleep(2000);
    }
  } finally { await remote; }
}
