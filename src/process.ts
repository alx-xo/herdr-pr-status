export type Runner = (argv: string[], cwd?: string) => Promise<string>;

/** A local command deadline, distinct from an ordinary nonzero exit. */
export class CommandTimeoutError extends Error {
  constructor(argv: string[], readonly timeoutMs: number) {
    super(`${argv[0]} ${argv[1] ?? ''} timed out after ${timeoutMs}ms`);
    this.name = 'CommandTimeoutError';
  }
}

/** No shell interpolation; settle only after the child and both pipes finish. */
export function createCommandRunner(timeoutMs = 30_000): Runner {
  return async (argv, cwd) => {
    const child = Bun.spawn(argv, {
      cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Git/gh may launch helpers that inherit output pipes. Kill the owned
      // process group too, otherwise waiting for EOF can hold the lane forever.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    try {
      // Do not race the deadline: the caller's slot remains occupied until
      // the killed child is reaped and output is drained, even if a read fails.
      const [stdout, stderr, code] = await Promise.allSettled([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      // Bun can report a signal-terminated process with exit code zero.
      if (timedOut) throw new CommandTimeoutError(argv, timeoutMs);
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
