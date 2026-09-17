import { expect, test } from 'bun:test';
import { runCommand } from '../src/process';

test('subprocess captures output and passes arguments literally', async () => {
  expect(await runCommand([process.execPath, '-e', 'console.log(Bun.argv[1])', '; echo unsafe'])).toBe('; echo unsafe\n');
});
test('subprocess failure retains diagnostic and exit code', async () => {
  await expect(runCommand([process.execPath, '-e', 'console.error("fixture failure"); process.exit(3)'])).rejects.toThrow('failed (3): fixture failure');
});
