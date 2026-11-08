import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const [name, spec] of Object.entries(manifest.dependencies)) {
  if (!spec.startsWith('file:')) continue;
  const sibling = JSON.parse(await readFile(resolve(root, spec.slice(5), 'package.json'), 'utf8'));
  if (sibling.name !== name || !sibling.version) throw new Error(`Invalid sibling package: ${name}`);
  manifest.dependencies[name] = `^${sibling.version}`;
}
const staging = await mkdtemp(join(tmpdir(), 'maestro-flow-publish-'));
for (const path of [...new Set([...manifest.files, 'README.md', 'LICENSE', 'CHANGELOG.md', 'src', 'tsconfig.json'])]) {
  await cp(join(root, path), join(staging, path), { recursive: true });
}
await symlink(join(root, 'node_modules'), join(staging, 'node_modules'), 'junction');
await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(staging);
