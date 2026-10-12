/** Race a bounded command against a runtime failure, but never leave the
 * command outstanding when the caller enters cleanup. Its later rejection must
 * not replace the runtime failure that won the race. Omit failure for cleanup. */
export async function joinCommand(command: Promise<string>, failure?: Promise<never>): Promise<string> {
  try {
    return await (failure ? Promise.race([command, failure]) : command);
  } finally {
    await command.catch(() => {});
  }
}

/** Integration-only runner: explicit environment and a bounded capture/drain. */
export async function runIsolatedCommand(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  { timeoutMs = 10_000, maxOutputBytes = 1024 * 1024, drainMs = 250 } = {},
): Promise<string> {
  // A negative PID is safe only for a group created by this spawn. Never fall
  // back to an inherited process group (which could include the test harness).
  if (process.platform === 'win32') throw new Error('Integration requires POSIX process groups');
  const child = Bun.spawn(argv, {
    cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
  });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  let failure: Error | undefined;
  let capturedBytes = 0;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let finishDrain!: () => void;
  const drainExpired = new Promise<void>(resolve => { finishDrain = resolve; });
  const terminate = (error: Error) => {
    if (failure) return;
    failure = error;
    // Kill descendants still in our private group, including when the direct
    // child already exited but a helper kept its stdout/stderr open.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    drainTimer = setTimeout(() => {
      // Escaped descendants can retain pipes even after the group is killed.
      // Cancel without awaiting cancellation; neither drain nor reaping may
      // extend the command deadline indefinitely.
      for (const reader of readers) void reader.cancel().catch(() => {});
      finishDrain();
    }, drainMs);
  };
  const timer = setTimeout(() => terminate(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    let output = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (failure) { output = ''; continue; }
        // Count bytes before UTF-8 decoding; stdout and stderr share a budget.
        if (value.byteLength > maxOutputBytes - capturedBytes) {
          output = '';
          terminate(new Error(`Command output exceeded ${maxOutputBytes} bytes`));
          continue;
        }
        capturedBytes += value.byteLength;
        output += decoder.decode(value, { stream: true });
      }
      return failure ? '' : output + decoder.decode();
    } catch (error) {
      terminate(error instanceof Error ? error : new Error(String(error)));
      return '';
    } finally { reader.releaseLock(); }
  };
  try {
    // allSettled also observes late failures after the bounded drain wins.
    const result = await Promise.race([
      Promise.allSettled([read(readers[0]!), read(readers[1]!), child.exited]),
      drainExpired,
    ]);
    if (failure) throw failure;
    if (!result) throw new Error('Command drain expired');
    const [out, err, code] = result;
    if (out.status === 'rejected') throw out.reason;
    if (err.status === 'rejected') throw err.reason;
    if (code.status === 'rejected') throw code.reason;
    if (code.value !== 0 || child.signalCode) {
      throw new Error(`${argv.slice(0, 4).join(' ')} failed (${child.signalCode ?? code.value}): ${err.value.slice(-1500)}`);
    }
    return out.value;
  } finally {
    clearTimeout(timer);
    clearTimeout(drainTimer);
  }
}
