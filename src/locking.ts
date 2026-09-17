import { dlopen, FFIType } from 'bun:ffi';
import { constants, closeSync, openSync } from 'node:fs';

// Kernel leases survive crashes safely: files are NEVER unlinked; no PID signals.
const openLibrary = () => {
  const symbols = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } };
  if (process.platform === 'darwin') return dlopen('/usr/lib/libSystem.B.dylib', symbols);
  try { return dlopen('libc.so.6', symbols); }
  catch { return dlopen('libc.so', symbols); } // musl Linux
};
let library: ReturnType<typeof openLibrary> | undefined;
export function tryLock(path: string): (() => void) | undefined {
  library ??= openLibrary();
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  if (library.symbols.flock!(fd, 2 | 4) !== 0) { closeSync(fd); return; }
  return () => closeSync(fd);
}
export async function serialized<T>(path: string, work: () => Promise<T>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const release = tryLock(path);
    if (release) { try { return await work(); } finally { release(); } }
    if (Date.now() >= deadline) throw new Error('PR refresh is busy; retry after the current cycle completes');
    await Bun.sleep(50);
  }
}
