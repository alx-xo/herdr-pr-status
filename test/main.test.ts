import { expect, test } from "bun:test";

const entrypoint = new URL("../src/main.ts", import.meta.url).pathname;

test("info describes the polling POC", () => {
  const result = Bun.spawnSync([process.execPath, entrypoint, "info"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("No GitHub writes");
});

test("unknown commands fail clearly", () => {
  const result = Bun.spawnSync([process.execPath, entrypoint, "unknown"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Unknown command");
});

test('preview refuses to control Herdr outside its environment', () => {
  const result = Bun.spawnSync([process.execPath, entrypoint, 'preview'], { env: { ...process.env, HERDR_ENV: '' } });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('Run preview/refresh inside Herdr');
});

test('extra arguments are rejected rather than ignored', () => {
  const result = Bun.spawnSync([process.execPath, entrypoint, 'refresh', '--guess']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('Unknown command or arguments');
});

test('invalid on-disk config fails before contacting Herdr', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pr-status-config-'));
  try {
    await writeFile(join(dir, 'config.json'), '{"hideZeroThreads":"yes"}');
    const result = Bun.spawnSync([process.execPath, entrypoint, 'refresh'], {
      env: { ...process.env, HERDR_ENV: '1', HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_BIN_PATH: '/does-not-exist' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('hideZeroThreads must be boolean');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lifecycle actions explain missing Herdr session directories', () => {
  for (const action of ['start', 'stop', 'status']) {
    const result = Bun.spawnSync([process.execPath, entrypoint, action], {
      env: { ...process.env, HERDR_ENV: '1', HERDR_PLUGIN_STATE_DIR: '', HERDR_SOCKET_PATH: '' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('HERDR_PLUGIN_STATE_DIR');
  }
});
