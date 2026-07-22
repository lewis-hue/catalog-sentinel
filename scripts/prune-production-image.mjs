import { readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const applicationRoot = resolve('/app');
const removablePackages = new Set(['tsx', 'typescript', 'vitest', 'postcss', 'sharp']);
const packageDirectories = [];

async function collect(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collect(path);
      continue;
    }
    if (!entry.isFile() || entry.name !== 'package.json') continue;
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (removablePackages.has(manifest.name)) packageDirectories.push(dirname(path));
  }
}

await collect(applicationRoot);

// Delete deepest paths first. Every target must be a real package directory
// below /app/**/node_modules; no caller-controlled path or glob is accepted.
packageDirectories.sort((left, right) => right.length - left.length);
for (const packageDirectory of packageDirectories) {
  const canonical = await realpath(packageDirectory);
  const relativePath = relative(applicationRoot, canonical);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || !relativePath.split(sep).includes('node_modules')
  ) {
    throw new Error(`refusing to prune package outside /app node_modules: ${canonical}`);
  }
  await rm(canonical, { recursive: true, force: false });
  console.log(`Pruned build-only runtime package: ${relativePath}`);
}
