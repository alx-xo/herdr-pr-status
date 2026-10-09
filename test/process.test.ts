import { expect, spyOn, test } from 'bun:test';
import { CommandOutputLimitError, CommandTimeoutError, createCommandRunner, runCommand } from '../src/process';

test('subprocess captures output and passes arguments literally', async () => {
  expect(await runCommand([process.execPath, '-e', 'console.log(Bun.argv[1])', '; echo unsafe'])).toBe('; echo unsafe\n');
});
test('subprocess failure retains diagnostic and exit code', async () => {
  await expect(runCommand([process.execPath, '-e', 'console.error("fixture failure"); process.exit(3)'])).rejects.toThrow('failed (3): fixture failure');
});

test('stdout overrun is a bounded failure distinct from command exit', async () => {
  const error = await createCommandRunner(1000, 4)([process.execPath, '-e', 'process.stdout.write("secret")']).catch(error => error);
  expect(error).toBeInstanceOf(CommandOutputLimitError);
  expect(error.maxOutputBytes).toBe(4);
  expect(error.message).toContain('output exceeded 4 bytes');
  expect(error.message).not.toContain('secret');
});

test('the exact combined byte boundary succeeds with split UTF-8 output', async () => {
  const output = await createCommandRunner(1000, 5)([process.execPath, '-e', `
    const { writeSync } = require('node:fs');
    writeSync(1, Buffer.from([0xe2]));
    setTimeout(() => { writeSync(1, Buffer.from([0x82, 0xac])); writeSync(2, 'ok'); }, 10);
  `]);
  expect(output).toBe('€');
});

for (const [label, source] of [
  ['stderr', 'process.stderr.write("12345")'],
  ['combined UTF-8', 'process.stdout.write("€"); process.stderr.write("ok")'],
] as const) {
  test(`${label} overrun uses the same byte budget`, async () => {
    await expect(createCommandRunner(1000, 4)([process.execPath, '-e', source])).rejects.toBeInstanceOf(CommandOutputLimitError);
  });
}

test('the exported runner applies the 8 MiB default cap', async () => {
  const error = await runCommand([process.execPath, '-e', 'process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1))']).catch(error => error);
  expect(error).toBeInstanceOf(CommandOutputLimitError);
  expect(error.maxOutputBytes).toBe(8 * 1024 * 1024);
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


for (const firstCause of ['output', 'timeout'] as const) {
  test(`${firstCause} wins the race, kills the owned group, and awaits reap plus both EOFs`, async () => {
    const killed = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const child = {
      pid: 12345,
      stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }),
      exited: exited.promise,
      signalCode: 'SIGKILL',
    };
    const spawn = spyOn(Bun, 'spawn').mockReturnValue(child as unknown as ReturnType<typeof Bun.spawn>);
    const kill = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-12345);
      expect(signal).toBe('SIGKILL');
      killed.resolve();
      return true;
    });
    const realSetTimeout = globalThis.setTimeout;
    let deadline!: () => void;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      deadline = callback;
      return realSetTimeout(() => {}, 60_000);
    }) as typeof setTimeout);
    let settled = false;
    const result = createCommandRunner(1000, 4)(['fixture']).catch(error => error).finally(() => { settled = true; });
    try {
      if (firstCause === 'timeout') deadline();
      stdout.enqueue(new Uint8Array([1, 2, 3]));
      stderr.enqueue(new Uint8Array([4, 5]));
      await killed.promise;
      if (firstCause === 'output') deadline();
      // More output after termination must still drain, without changing cause.
      stdout.enqueue(new Uint8Array(100));
      stderr.enqueue(new Uint8Array(100));
      await Bun.sleep(0);
      expect(settled).toBe(false);
      stdout.close();
      await Bun.sleep(0);
      expect(settled).toBe(false);
      if (firstCause === 'output') stderr.close();
      else exited.resolve(0);
      await Bun.sleep(0);
      expect(settled).toBe(false);
      if (firstCause === 'output') exited.resolve(0);
      else stderr.close();
      expect(await result).toBeInstanceOf(firstCause === 'output' ? CommandOutputLimitError : CommandTimeoutError);
    } finally {
      // Erroring an already closed stream is harmless; release pending reads
      // even when an assertion fails before the explicit EOF steps above.
      stdout.error(new Error('fixture cleanup'));
      stderr.error(new Error('fixture cleanup'));
      exited.resolve(0);
      await result;
      timer.mockRestore();
      kill.mockRestore();
      spawn.mockRestore();
    }
  });
}

test('timeout kills inherited-pipe helpers and releases the command slot', async () => {
  const started = performance.now();
  await expect(createCommandRunner(40)(['sh', '-c', 'sleep 2 & wait'])).rejects.toBeInstanceOf(CommandTimeoutError);
  expect(performance.now() - started).toBeLessThan(1000);
});
