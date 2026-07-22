import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const forbiddenPackages = new Set(['tsx', 'typescript', 'vitest', 'postcss', 'sharp']);
const forbiddenPackageLocations = [];
const browserExecutables = [];
const browserExecutableName = /^(?:chrome|chrome-wrapper|chrome-headless-shell|headless_shell|google-chrome(?:-stable)?|chromium(?:-browser)?|firefox|xvfb|x11vnc|websockify)$/i;

async function inspectTree(root, { inspectPackages = false, inspectExecutables = false } = {}) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await inspectTree(path, { inspectPackages, inspectExecutables });
      continue;
    }
    if (!entry.isFile()) continue;

    if (inspectPackages && entry.name === 'package.json') {
      try {
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        if (forbiddenPackages.has(manifest.name)) forbiddenPackageLocations.push(path);
      } catch (error) {
        throw new Error(`invalid runtime package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (inspectExecutables && browserExecutableName.test(basename(path))) {
      const metadata = await stat(path);
      if ((metadata.mode & 0o111) !== 0) browserExecutables.push(path);
    }
  }
}

await inspectTree('/app', { inspectPackages: true, inspectExecutables: true });
for (const root of ['/usr/bin', '/usr/local/bin', '/opt', '/home/node/.cache']) {
  await inspectTree(root, { inspectExecutables: true });
}

for (const browserInstallRoot of [
  '/ms-playwright',
  '/root/.cache/ms-playwright',
  '/home/node/.cache/ms-playwright',
  '/app/node_modules/playwright-core/.local-browsers',
  '/opt/google/chrome',
  '/opt/chromium',
]) {
  try {
    await stat(browserInstallRoot);
    browserExecutables.push(browserInstallRoot);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
}

if (forbiddenPackageLocations.length > 0) {
  throw new Error(`forbidden runtime packages: ${forbiddenPackageLocations.join(', ')}`);
}
if (browserExecutables.length > 0) {
  throw new Error(`local browser/display executables: ${browserExecutables.join(', ')}`);
}

const requiredArtifacts = [
  '/app/api.cjs',
  '/app/worker.cjs',
  '/app/apps/web/server.js',
  '/app/node_modules/playwright/package.json',
  '/app/node_modules/@prisma/client/package.json',
  '/app/node_modules/prisma/package.json',
];
for (const path of requiredArtifacts) await stat(path);

// These source-only roots contain local orchestration data, captured pages, or
// deterministic parser fixtures. Dockerfile.production uses selective COPYs,
// and this assertion prevents a future broad COPY from silently shipping them.
for (const path of ['/app/artifacts', '/app/captures', '/app/fixtures', '/app/docker']) {
  try {
    await stat(path);
    throw new Error(`source-only content is present in the production image: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('source-only content')) throw error;
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
}

console.log('Production image filesystem assertions passed.');
