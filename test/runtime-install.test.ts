import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, cp, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { version } from '../package.json';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(os = 'Darwin', arch = 'arm64') {
  const root = await mkdtemp(join(tmpdir(), 'pr-runtime-test-')); roots.push(root);
  for (const dir of ['scripts', 'tools', 'release', 'home']) await mkdir(join(root, dir));
  await writeFile(join(root, 'herdr-plugin.toml'), 'id = "alx-xo.pr-status"\nversion = "0.5.0"\n');
  await copyFile(resolve('scripts/install-runtime.sh'), join(root, 'scripts/install-runtime.sh'));
  await copyFile(resolve('scripts/run.sh'), join(root, 'scripts/run.sh'));
  const env = { PATH: `${root}/tools:/usr/bin:/bin`, HOME: `${root}/home`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', FIXTURE: root };
  const command = (argv: string[], extra: Record<string, string> = {}) => Bun.spawnSync(argv, { cwd: root, env: { ...env, ...extra } });
  for (const argv of [['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) expect(command(argv).exitCode).toBe(0);
  const revision = command(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
  await writeFile(join(root, 'tools/uname'), `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${arch};; esac\n`, { mode: 0o755 });
  await writeFile(join(root, 'tools/curl'), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in --output) shift; out=$1;; https:*) url=$1;; esac\n shift\ndone\nprintf '%s\\n' "$url" >> "$FIXTURE/urls"\ncp "$FIXTURE/release/\${url##*/}" "$out"\n`, { mode: 0o755 });
  const asset = `pr-status-${os === 'Darwin' ? 'darwin' : 'linux'}-${['arm64', 'aarch64'].includes(arch) ? 'arm64' : 'x64'}`;
  const binary = `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 2\necho 'pr-status 0.5.0 (${revision})'\n`;
  await writeFile(join(root, 'release', asset), binary);
  await writeFile(join(root, 'release/SOURCE_COMMIT'), `${revision}\n`);
  const checksum = new Bun.CryptoHasher('sha256').update(binary).digest('hex');
  await writeFile(join(root, 'release/SHA256SUMS'), `${"0".repeat(64)}  unrelated-asset\n${checksum}  ${asset}\n`);
  return { root, revision, asset, command, install: () => command(['sh', 'scripts/install-runtime.sh']) };
}
test('installer selects a pinned verified native release matching this checkout', async () => {
  const f = await fixture();
  const result = f.install();
  expect(result.exitCode).toBe(0);
  expect(f.command(['./bin/pr-status', '--version']).stdout.toString().trim()).toBe(`pr-status 0.5.0 (${f.revision})`);
  expect(await readFile(join(f.root, 'urls'), 'utf8')).toContain('https://github.com/alx-xo/herdr-pr-status/releases/download/v0.5.0/pr-status-darwin-arm64');
});

test('installer refuses a release built from a different source revision', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'release/SOURCE_COMMIT'), '0000000000000000000000000000000000000000\n');
  const result = f.install();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Unreleased checkout');
  expect(await Bun.file(join(f.root, 'bin/pr-status')).exists()).toBe(false);
});
test('installer refuses corrupted bytes and leaves an existing runtime intact', async () => {
  const f = await fixture();
  expect(f.install().exitCode).toBe(0);
  const before = await readFile(join(f.root, 'bin/pr-status'));
  await writeFile(join(f.root, 'release', f.asset), 'corrupted');
  const result = f.install();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('checksum mismatch');
  expect(await readFile(join(f.root, 'bin/pr-status'))).toEqual(before);
});
test('installer reports unavailable downloads without building source', async () => {
  const f = await fixture();
  await rm(join(f.root, 'release/SOURCE_COMMIT'));
  const result = f.install();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('Download failed');
});
test.each([['FreeBSD', 'arm64', 'Unsupported OS'], ['Darwin', 'riscv64', 'Unsupported architecture']])('installer rejects %s/%s', async (os, arch, message) => {
  const f = await fixture(os, arch);
  const result = f.install();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(message);
});
test('launcher rejects a missing binary and forwards arguments to the installed runtime', async () => {
  const f = await fixture();
  let result = f.command(['sh', 'scripts/run.sh', 'info']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('Missing binary');
  expect(f.install().exitCode).toBe(0);
  result = f.command(['sh', 'scripts/run.sh', '--version']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`pr-status 0.5.0 (${f.revision})\n`);
});

test('an installed runtime failure never falls back to source; explicit local opt-in runs current source', async () => {
  const f = await fixture();
  await symlink(process.execPath, join(f.root, 'tools/bun'));
  await cp(resolve('src'), join(f.root, 'src'), { recursive: true });
  await copyFile(resolve('package.json'), join(f.root, 'package.json'));
  await mkdir(join(f.root, 'bin'));
  await writeFile(join(f.root, 'bin/pr-status'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  expect(f.command(['sh', 'scripts/run.sh', 'info']).exitCode).toBe(42);
  await writeFile(join(f.root, '.pr-status-source'), '');
  const result = f.command(['sh', 'scripts/run.sh', '--version'], { BUN_BE_BUN: '1' });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`pr-status ${version} (source)\n`);
});
test.each([['Darwin', 'x86_64'], ['Linux', 'aarch64'], ['Linux', 'x86_64']])('installer selects %s/%s release asset', async (os, arch) => {
  const f = await fixture(os, arch);
  await writeFile(join(f.root, 'tools/getconf'), '#!/bin/sh\necho glibc 2.35\n', { mode: 0o755 });
  const result = f.install();
  expect(result.exitCode).toBe(0);
  const expected = os === 'Darwin' ? 'pr-status-darwin-x64' : arch === 'aarch64' ? 'pr-status-linux-arm64' : 'pr-status-linux-x64';
  expect(await readFile(join(f.root, 'urls'), 'utf8')).toContain(`/v0.5.0/${expected}\n`);
});
test('installer rejects musl rather than selecting a glibc binary', async () => {
  const f = await fixture('Linux', 'x86_64');
  await writeFile(join(f.root, 'tools/getconf'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = f.install();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('musl is not supported');
});
test.each(['version', 'revision'])('installer rejects an incorrect embedded %s even when release checksum matches', async field => {
  const f = await fixture();
  const identity = field === 'version' ? `pr-status 0.4.0 (${f.revision})` : 'pr-status 0.5.0 (0000000000000000000000000000000000000000)';
  const binary = `#!/bin/sh\necho '${identity}'\n`;
  await writeFile(join(f.root, 'release', f.asset), binary);
  await writeFile(join(f.root, 'release/SHA256SUMS'), `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  ${f.asset}\n`);
  const result = f.install();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('version/source identity mismatch');
});

test('installer rejects a checksum that belongs only to another asset', async () => {
  const f = await fixture();
  const checksums = await readFile(join(f.root, 'release/SHA256SUMS'), 'utf8');
  await writeFile(join(f.root, 'release/SHA256SUMS'), checksums.replace(f.asset, 'another-asset'));
  const result = f.install();
  expect(result.exitCode).not.toBe(0);
  expect(await Bun.file(join(f.root, 'bin/pr-status')).exists()).toBe(false);
});
