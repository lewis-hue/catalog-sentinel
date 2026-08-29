#!/usr/bin/env node
/**
 * Run the test suite against REAL Redis + Postgres.
 *
 * Why this exists: the integration suites are gated on `REDIS_URL` / `DATABASE_URL`, and the main
 * Compose stack deliberately doesn't publish those ports. So `npm test` on a dev box skipped
 * exactly the tests that catch cross-process defects, the ones that later found a pipeline whose
 * job ids BullMQ rejected outright, and a retry path that silently dropped every deferred chunk.
 * Both were invisible to 390 passing tests.
 *
 * This brings up throwaway loopback-only containers, applies migrations, runs the suite, and tears
 * them down. It never touches the development stack's data.
 *
 *   npm run test:infra            # whole suite
 *   npm run test:infra -- foo     # args pass through to vitest
 */
import { spawnSync } from 'node:child_process';

const COMPOSE = ['compose', '-f', 'docker-compose.test.yml'];
const REDIS_URL = 'redis://127.0.0.1:6399';
const DATABASE_URL = 'postgresql://sentinel:sentinel@127.0.0.1:55432/sentinel_test';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

const runQuiet = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });

function up() {
  console.log('Starting test infrastructure (loopback-only Redis :6399, Postgres :55432)…');
  const r = run('docker', [...COMPOSE, 'up', '-d', '--wait']);
  if (r.status !== 0) {
    console.error('\nCould not start test infrastructure. Is Docker running?');
    process.exit(1);
  }
}

function down() {
  // `-v` because the point of this stack is to leave nothing behind.
  run('docker', [...COMPOSE, 'down', '-v'], { stdio: 'ignore' });
}

function migrate() {
  console.log('Applying migrations…');
  const r = run('npx', ['prisma', 'migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL },
  });
  if (r.status !== 0) { down(); process.exit(1); }
}

function generatePrismaClient() {
  console.log('Generating Prisma client...');
  const r = run('npx', ['prisma', 'generate', '--schema', 'packages/db/prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL },
  });
  if (r.status !== 0) { down(); process.exit(1); }
}

/** Confirm the containers are actually reachable FROM THE HOST, not merely running. */
function verifyReachable() {
  const ping = runQuiet('docker', [...COMPOSE, 'exec', '-T', 'redis-test', 'redis-cli', 'ping']);
  if (!/PONG/i.test(ping.stdout ?? '')) {
    console.error('Redis container is up but not answering. Refusing to run tests that would silently skip.');
    down();
    process.exit(1);
  }
}

let exitCode = 1;
try {
  up();
  verifyReachable();
  generatePrismaClient();
  migrate();
  const vitestArgs = process.argv.slice(2);
  console.log(`Running tests with REDIS_URL + DATABASE_URL set${vitestArgs.length ? ` (${vitestArgs.join(' ')})` : ''}…\n`);
  const r = run('npx', ['vitest', 'run', ...vitestArgs], { env: { ...process.env, REDIS_URL, DATABASE_URL } });
  exitCode = r.status ?? 1;
} finally {
  console.log('\nTearing down test infrastructure…');
  down();
}
process.exit(exitCode);
