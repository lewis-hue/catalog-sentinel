#!/usr/bin/env node
/**
 * Fail CI when an infrastructure-gated test suite SKIPPED instead of running.
 *
 * Why this exists: every Redis/Postgres integration test is written as
 * `describe.skipIf(!REDIS_URL)`. That is correct for a laptop with no Redis — but in CI it meant
 * the suites that verify cross-process behaviour quietly skipped, and the run went green. A
 * pipeline whose workers consumed a queue no producer ever wrote to passed CI that way.
 *
 * A skipped test and a passing test look identical in a summary line. This makes them different.
 */
import { readFileSync } from 'node:fs';

/** Suites that MUST run in CI. Add one here whenever you gate a suite on infrastructure. */
const REQUIRED = [
  'RedisConnectSessionRegistry against real Redis',
  'DistroKid pipeline — API producer → real Redis → six-stage worker',
  'durable persistence — real Postgres',
  'deep-scan API↔worker handoff over Redis',
  'PrismaDistributorLinkRepository — Postgres integration',
];

const file = process.argv[2];
if (!file) {
  console.error('usage: assert-infra-tests-ran.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read the vitest report at ${file}: ${err.message}`);
  console.error('CI cannot confirm the infrastructure tests ran, so it must not pass.');
  process.exit(1);
}

const results = report.testResults ?? [];
const names = new Map();
for (const suite of results) {
  for (const t of suite.assertionResults ?? []) {
    const full = [...(t.ancestorTitles ?? []), t.title].join(' ');
    for (const req of REQUIRED) if (full.includes(req)) names.set(req, [...(names.get(req) ?? []), t.status]);
  }
}

let failed = false;
for (const req of REQUIRED) {
  const statuses = names.get(req);
  if (!statuses || statuses.length === 0) {
    console.error(`MISSING: "${req}" produced no tests at all. Is the suite still there?`);
    failed = true;
    continue;
  }
  const ran = statuses.filter((s) => s === 'passed' || s === 'failed').length;
  if (ran === 0) {
    console.error(`SKIPPED: "${req}" ran 0 of ${statuses.length} tests — the infrastructure it needs was not available.`);
    console.error('  CI provisions Redis + Postgres services; check REDIS_URL / DATABASE_URL are exported to the test step.');
    failed = true;
  } else {
    console.log(`OK: "${req}" ran ${ran} test(s).`);
  }
}

if (failed) {
  console.error('\nInfrastructure tests did not run. Failing the build rather than reporting a green tick that proves nothing.');
  process.exit(1);
}
console.log('\nAll required infrastructure suites ran.');
