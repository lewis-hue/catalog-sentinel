import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const [sourceArgument, destinationArgument, ...rootPackages] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || rootPackages.length === 0) {
  throw new Error(
    'usage: copy-production-dependencies.mjs <source-node_modules> <destination-node_modules> <package...>',
  );
}

const sourceRoot = resolve(sourceArgument);
const destinationRoot = resolve(destinationArgument);
const installRoot = dirname(sourceRoot);
const visited = new Set();

function packageSegments(name) {
  return name.startsWith('@') ? name.split('/') : [name];
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveInstalledPackage(name, importerDirectory) {
  let cursor = resolve(importerDirectory);
  while (true) {
    const candidate = join(cursor, 'node_modules', ...packageSegments(name));
    if (await exists(join(candidate, 'package.json'))) return candidate;
    if (cursor === installRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor || !parent.startsWith(installRoot)) break;
    cursor = parent;
  }

  const rootCandidate = join(sourceRoot, ...packageSegments(name));
  if (await exists(join(rootCandidate, 'package.json'))) return rootCandidate;
  return null;
}

async function copyPackage(packageDirectory) {
  const canonical = resolve(packageDirectory);
  if (visited.has(canonical)) return;
  visited.add(canonical);

  const relativePackagePath = relative(sourceRoot, canonical);
  if (
    !relativePackagePath
    || isAbsolute(relativePackagePath)
    || relativePackagePath === '..'
    || relativePackagePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`dependency resolved outside source node_modules: ${canonical}`);
  }

  const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'));
  const requiredPeers = Object.fromEntries(
    Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
    ),
  );
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...requiredPeers,
  };

  for (const name of Object.keys(dependencies).sort()) {
    const dependencyDirectory = await resolveInstalledPackage(name, canonical);
    if (!dependencyDirectory) {
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue;
      throw new Error(`${manifest.name} requires missing production dependency ${name}`);
    }
    await copyPackage(dependencyDirectory);
  }

  const destination = join(destinationRoot, relativePackagePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(canonical, destination, {
    recursive: true,
    // Dependencies are copied through this validated graph. Skipping embedded
    // node_modules prevents unrelated packages from hitchhiking in a parent.
    filter(source) {
      const nestedPath = relative(canonical, source);
      return !nestedPath.split(sep).includes('node_modules');
    },
  });
}

for (const name of rootPackages) {
  const packageDirectory = await resolveInstalledPackage(name, installRoot);
  if (!packageDirectory) throw new Error(`missing root production dependency ${name}`);
  await copyPackage(packageDirectory);
}

// Prisma generate writes the native client beside ordinary packages rather
// than into a package declared in package.json.
const generatedPrisma = join(sourceRoot, '.prisma');
if (!(await exists(generatedPrisma))) {
  throw new Error('Prisma client was not generated before dependency copying');
}
await cp(generatedPrisma, join(destinationRoot, '.prisma'), { recursive: true });

console.log(`Copied ${visited.size} production packages from the locked install.`);
