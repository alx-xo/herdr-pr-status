import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { version } from '../package.json';
const root = resolve(import.meta.dir, '..');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!targets.includes(target)) throw new Error(`Unsupported target: ${target}`);
const manifest = Bun.TOML.parse(await Bun.file(join(root, 'herdr-plugin.toml')).text());
if (!('version' in manifest) || manifest.version !== version) throw new Error('package.json and manifest versions must match');
const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
if (git.exitCode !== 0) throw new Error('Cannot determine source commit');
const revision = git.stdout.toString().trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Invalid source commit');
const output = resolve(process.argv[3] ?? join(root, 'dist/releases'));
await mkdir(output, { recursive: true });
const asset = `pr-status-${target}`;
// Baseline x64 avoids requiring AVX2 on the pinned compiler version.
const bunTarget = `bun-${target}${target.endsWith('-x64') ? '-baseline' : ''}`;
const child = Bun.spawn([process.execPath, 'build', '--compile', `--target=${bunTarget}`,
  '--define', `RELEASE_COMMIT=${JSON.stringify(revision)}`, join(root, 'src/main.ts'), '--outfile', join(output, asset)],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (await child.exited !== 0) throw new Error(`Compilation failed: ${target}`);
const checksum = new Bun.CryptoHasher('sha256').update(await Bun.file(join(output, asset)).arrayBuffer()).digest('hex');
await writeFile(join(output, `${asset}.sha256`), `${checksum}  ${asset}\n`);
await writeFile(join(output, 'SOURCE_COMMIT'), `${revision}\n`);
