export type Runner = (argv: string[], cwd?: string) => Promise<string>;

/** No shell interpolation; bound every external command, including Herdr. */
export const runCommand: Runner = async (argv, cwd) => {
  const child = Bun.spawn(argv, {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    timeout: 30_000, killSignal: 'SIGKILL',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ''} failed (${child.signalCode ?? code}): ${stderr.trim().slice(0, 800)}`);
  return stdout;
};
