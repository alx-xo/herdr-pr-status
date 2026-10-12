import { expect, test } from 'bun:test';
import { captureServerOutput } from './server-output';
import { joinCommand, runIsolatedCommand } from './command';
import { isolatedEnv, waitFor } from './helpers';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No Herdr runtime: exercise the server pipe boundary directly.
test('combined raw-byte overflow interrupts a pending operation without exposing output', async () => {
  const secret = 'private-control-token';
  const stream = () => new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(secret)); },
  });
  const capture = captureServerOutput([stream(), stream()], 30);
  try {
    await expect(Promise.race([new Promise<void>(() => {}), capture.failure]))
      .rejects.toThrow('Server output exceeded 30 bytes');
    expect(() => capture.check()).toThrow('Server output exceeded 30 bytes');
    expect(() => capture.check()).not.toThrow(secret);
  } finally { capture.stop(); }
});

test('bounds draining a pipe held open after server exit', async () => {
  const capture = captureServerOutput([new ReadableStream<Uint8Array>()]);
  const start = Date.now();
  await expect(capture.finish(20)).rejects.toThrow('Server output drain timed out');
  expect(Date.now() - start).toBeLessThan(1000);
});

for (const exitCode of [0, 7]) {
  test(`overflow joins a delayed child before cleanup (exit ${exitCode})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'herdr-command-join-'));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const capture = captureServerOutput([new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    })], 1);
    let settled = false;
    const command = runIsolatedCommand([process.execPath, '-e', `
      const { existsSync, writeFileSync } = require('node:fs');
      writeFileSync('ready', '');
      while (!existsSync('release')) await Bun.sleep(10);
      await Bun.sleep(80);
      writeFileSync('finished', 'done');
      process.exit(${exitCode});
    `], root, isolatedEnv(root), { timeoutMs: 2000 }).finally(() => { settled = true; });
    const operation = joinCommand(command, capture.failure);
    // Observe early failures even while waiting for the child handshake.
    void operation.catch(() => {});
    try {
      await waitFor('fixture ready', async () => existsSync(join(root, 'ready')) ? true : undefined, 1000);
      expect(settled).toBe(false);
      controller.enqueue(new Uint8Array(2));
      await expect(capture.failure).rejects.toThrow('Server output exceeded 1 bytes');
      await writeFile(join(root, 'release'), '');
      try {
        await expect(operation).rejects.toThrow('Server output exceeded 1 bytes');
      } finally {
        // This is the runner's cleanup boundary: no command can still mutate root.
        expect(settled).toBe(true);
        expect(await readFile(join(root, 'finished'), 'utf8')).toBe('done');
        // Cleanup deliberately omits the already-rejected runtime failure.
        expect(await joinCommand(runIsolatedCommand(
          [process.execPath, '-e', 'process.stdout.write("cleanup")'], root, isolatedEnv(root),
        ))).toBe('cleanup');
      }
    } finally {
      capture.stop();
      await command.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
