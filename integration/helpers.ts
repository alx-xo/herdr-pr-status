/** Allowlist, not a credential denylist: no caller environment is spread. */
export function isolatedEnv(root: string): Record<string, string> {
  return {
    PATH: `${root}/bin:/usr/bin:/bin`, HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`, XDG_STATE_HOME: `${root}/state`,
    XDG_CACHE_HOME: `${root}/cache`, XDG_DATA_HOME: `${root}/data`,
    XDG_RUNTIME_DIR: `${root}/runtime`, TMPDIR: `${root}/tmp`,
    GH_CONFIG_DIR: `${root}/gh`, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: `${root}/gitconfig`, GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: '', SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    HERDR_ENV: '1', HERDR_SESSION: 'integration',
    HERDR_CONFIG_PATH: `${root}/config/herdr/config.toml`,
    HERDR_SOCKET_PATH: `${root}/api.sock`,
  };
}

export async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  do {
    const result = await probe();
    if (result !== undefined) return result;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

/** An inspection failure is tolerable only when independent liveness says gone. */
export async function inspectUnlessGone<T>(read: () => Promise<T>, alive: () => boolean): Promise<T | undefined> {
  try { return await read(); }
  catch (error) { if (alive()) throw error; return undefined; }
}
