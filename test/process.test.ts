import { expect, spyOn, test } from 'bun:test';
import { CommandTimeoutError, createCommandRunner, runCommand } from '../src/process';

test('subprocess captures output and passes arguments literally', async () => {
  expect(await runCommand([process.execPath, '-e', 'console.log(Bun.argv[1])', '; echo unsafe'])).toBe('; echo unsafe\n');
});
test('subprocess failure retains diagnostic and exit code', async () => {
  await expect(runCommand([process.execPath, '-e', 'console.error("fixture failure"); process.exit(3)'])).rejects.toThrow('failed (3): fixture failure');
});

test('subprocess deadline is distinguishable from command failure', async () => {
  const run = createCommandRunner(25);
  const error = await run([process.execPath, '-e', 'setInterval(() => {}, 1000)']).catch(error => error);
  expect(error).toBeInstanceOf(CommandTimeoutError);
  expect(error.timeoutMs).toBe(25);
  expect(error.message).toContain('timed out after 25ms');
  expect(await createCommandRunner(1000)([process.execPath, '-e', 'console.log("next")'])).toBe('next\n');
});

for (const exitCode of [0, 137]) {
  test(`timeout stays pending until reaped and drained (exit ${exitCode})`, async () => {
    // The OS process boundary lets us deterministically control exit and EOF
    // ordering, including Bun's signal-with-zero-exit behavior.
    const killed = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const child = {
      stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }),
      exited: exited.promise,
      signalCode: 'SIGKILL',
      kill(signal: string) {
        expect(signal).toBe('SIGKILL');
        killed.resolve();
      },
    };
    const spawn = spyOn(Bun, 'spawn').mockReturnValue(child as unknown as ReturnType<typeof Bun.spawn>);
    let settled = false;
    const result = createCommandRunner(1)(['fixture']).catch(error => error).finally(() => { settled = true; });
    try {
      await killed.promise;
      await Bun.sleep(0);
      expect(settled).toBe(false);
      exited.resolve(exitCode);
      await Bun.sleep(0);
      expect(settled).toBe(false);
      stdout.close();
      await Bun.sleep(0);
      expect(settled).toBe(false);
      stderr.close();
      expect(await result).toBeInstanceOf(CommandTimeoutError);
    } finally {
      exited.resolve(exitCode);
      spawn.mockRestore();
    }
  });
}

test('timeout kills inherited-pipe helpers and releases the command slot', async () => {
  const started = performance.now();
  await expect(createCommandRunner(40)(['sh', '-c', 'sleep 2 & wait'])).rejects.toBeInstanceOf(CommandTimeoutError);
  expect(performance.now() - started).toBeLessThan(1000);
});
