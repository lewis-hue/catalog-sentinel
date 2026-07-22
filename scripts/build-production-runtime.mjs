import { builtinModules } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const outputDirectory = resolve(root, 'dist', 'production-runtime');

// These packages deliberately remain external. Playwright is the CDP client for
// Steel (no browser is installed); Prisma ships native engines and a migration
// CLI that cannot safely be folded into a JavaScript bundle. Telemetry remains
// optional. AWS SDK clients are bundled because KMS/governance are mandatory;
// externalizing them without copying their graph made the final image unloadable.
const allowedPackageExternals = [
  /^playwright(?:\/|$)/,
  /^@prisma\/client(?:\/|$)/,
  /^@opentelemetry\//,
  // Optional native acceleration used only when callers explicitly request
  // `pg.native`; this service always uses the portable pg client.
  /^pg-native$/,
];
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

await mkdir(outputDirectory, { recursive: true });

async function bundle(name, entryPoint) {
  // Resolve every build input before handing it to esbuild. Relative entry
  // points make esbuild's service process infer a working directory of its
  // own on some Windows/sandbox combinations, which can make it walk above
  // the repository and fail with an access-denied error even though the
  // source file exists. Keeping the repository root and tsconfig explicit
  // makes the exact same invocation deterministic on developer hosts and in
  // the Linux release container.
  const resolvedEntryPoint = resolve(root, entryPoint);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolvedEntryPoint],
    tsconfig: resolve(root, 'tsconfig.json'),
    outfile: resolve(outputDirectory, `${name}.cjs`),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    logLevel: 'info',
    metafile: true,
    sourcemap: false,
    // Preserve third-party license and attribution comments in the emitted
    // bundles while keeping them out of the executable prologue.
    legalComments: 'eof',
    external: [
      'playwright',
      '@prisma/client',
      '@opentelemetry/*',
      'pg-native',
    ],
  });

  const unexpected = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((dependency) => dependency.external)
    .map((dependency) => dependency.path)
    .filter((dependency) =>
      !nodeBuiltins.has(dependency)
      && !allowedPackageExternals.some((pattern) => pattern.test(dependency)),
    );

  if (unexpected.length > 0) {
    throw new Error(
      `${name} bundle has unexpected runtime dependencies: ${[...new Set(unexpected)].join(', ')}`,
    );
  }
}

await Promise.all([
  bundle('api', 'apps/api/src/main.ts'),
  bundle('worker', 'apps/worker/src/main.ts'),
]);

// Preserve the commands used by the production Compose file without shipping
// tsx, TypeScript sources, or the repository's development manifest.
await writeFile(
  resolve(outputDirectory, 'package.json'),
  `${JSON.stringify({
    name: 'artist-catalog-sentinel-runtime',
    private: true,
    version: '0.1.0',
    workspaces: ['apps/web', 'packages/db'],
    scripts: {
      api: 'node ./api.cjs',
      worker: 'node ./worker.cjs',
    },
  }, null, 2)}\n`,
);

await mkdir(resolve(outputDirectory, 'apps', 'web'), { recursive: true });
await writeFile(
  resolve(outputDirectory, 'apps', 'web', 'package.json'),
  `${JSON.stringify({
    name: '@sentinel/web',
    private: true,
    version: '0.1.0',
    scripts: { start: 'node ./server.js' },
  }, null, 2)}\n`,
);

await mkdir(resolve(outputDirectory, 'packages', 'db'), { recursive: true });
await writeFile(
  resolve(outputDirectory, 'packages', 'db', 'package.json'),
  `${JSON.stringify({
    name: '@sentinel/db',
    private: true,
    version: '0.1.0',
    scripts: {
      'db:migrate:deploy': 'node /app/node_modules/prisma/build/index.js migrate deploy --schema ./prisma/schema.prisma',
    },
  }, null, 2)}\n`,
);
