export type Runner = (argv: string[], cwd?: string) => Promise<string>;

/** A local command deadline, distinct from an ordinary nonzero exit. */
export class CommandTimeoutError extends Error {
  constructor(argv: string[], readonly timeoutMs: number) {
    super(`${argv[0]} ${argv[1] ?? ''} timed out after ${timeoutMs}ms`);
    this.name = 'CommandTimeoutError';
  }
}

/** Captured stdout and stderr share one byte budget. */
export class CommandOutputLimitError extends Error {
  constructor(argv: string[], readonly maxOutputBytes: number) {
    super(`${argv[0]} ${argv[1] ?? ''} output exceeded ${maxOutputBytes} bytes`);
    this.name = 'CommandOutputLimitError';
  }
}

/** No shell interpolation; settle only after the child and both pipes finish. */
export function createCommandRunner(timeoutMs = 30_000, maxOutputBytes = 8 * 1024 * 1024): Runner {
  return async (argv, cwd) => {
    const child = Bun.spawn(argv, {
      cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
    });
    let failure: CommandTimeoutError | CommandOutputLimitError | undefined;
    const terminate = (error: CommandTimeoutError | CommandOutputLimitError) => {
      if (failure) return;
      failure = error;
      // Git/gh may launch helpers that inherit output pipes. Kill the owned
      // process group too, otherwise waiting for EOF can hold the lane forever.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => terminate(new CommandTimeoutError(argv, timeoutMs)), timeoutMs);
    let capturedBytes = 0;
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let output = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Count raw bytes before decoding; both readers share this budget.
          // After termination, discard everything but keep draining to EOF.
          if (failure) { output = ''; continue; }
          if (value.byteLength > maxOutputBytes - capturedBytes) {
            output = '';
            terminate(new CommandOutputLimitError(argv, maxOutputBytes));
            continue;
          }
          capturedBytes += value.byteLength;
          output += decoder.decode(value, { stream: true });
        }
        return failure ? '' : output + decoder.decode();
      } finally {
        reader.releaseLock();
      }
    };
    try {
      // Do not race the deadline: the caller's slot remains occupied until
      // the killed child is reaped and output is drained, even if a read fails.
      const [stdout, stderr, code] = await Promise.allSettled([
        read(child.stdout), read(child.stderr), child.exited,
      ]);
      // Bun can report a signal-terminated process with exit code zero.
      if (failure) throw failure;
      if (stdout.status === 'rejected') throw stdout.reason;
      if (stderr.status === 'rejected') throw stderr.reason;
      if (code.status === 'rejected') throw code.reason;
      if (code.value !== 0 || child.signalCode) throw new Error(`${argv[0]} ${argv[1] ?? ''} failed (${child.signalCode ?? code.value}): ${stderr.value.trim().slice(0, 800)}`);
      return stdout.value;
    } finally {
      clearTimeout(timer);
    }
  };
}

export const runCommand: Runner = createCommandRunner();
