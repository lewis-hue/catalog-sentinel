#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

function positiveInteger(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function finiteNumber(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function requireSafeBaseUrl() {
  const raw = process.env.SENTINEL_BASE_URL?.trim();
  if (!raw) throw new Error('SENTINEL_BASE_URL is required');
  const url = new URL(raw);
  const loopback = new Set(['localhost', '127.0.0.1', '::1']).has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SENTINEL_BASE_URL must use HTTPS (HTTP is allowed only for loopback)');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function requestHeaders() {
  const token = process.env.SENTINEL_ACCEPTANCE_TOKEN?.trim();
  const cookie = process.env.SENTINEL_ACCEPTANCE_COOKIE?.trim();
  if (Boolean(token) === Boolean(cookie)) {
    throw new Error('Set exactly one of SENTINEL_ACCEPTANCE_TOKEN or SENTINEL_ACCEPTANCE_COOKIE');
  }
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : { cookie }),
  };
}

function target(base, rawPath) {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) throw new Error('load paths must be absolute same-origin paths');
  const url = new URL(rawPath, base);
  if (url.origin !== base.origin) throw new Error('load paths must remain on SENTINEL_BASE_URL');
  return url;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const baseUrl = requireSafeBaseUrl();
const headers = requestHeaders();
const durationSeconds = positiveInteger('SENTINEL_SOAK_SECONDS', 300, 10, 86_400);
const concurrency = positiveInteger('SENTINEL_SOAK_CONCURRENCY', 20, 1, 2_000);
const timeoutMs = positiveInteger('SENTINEL_REQUEST_TIMEOUT_MS', 10_000, 250, 120_000);
const minimumRequests = positiveInteger('SENTINEL_MIN_REQUESTS', 1_000, 1, 100_000_000);
const maximumP95Ms = positiveInteger('SENTINEL_MAX_P95_MS', 1_000, 1, 120_000);
const maximumErrorRate = finiteNumber('SENTINEL_MAX_ERROR_RATE', 0.005, 0, 1);
const requestPath = process.env.SENTINEL_LOAD_PATH?.trim() || '/bff/api/searches?limit=25';
const readinessPath = process.env.SENTINEL_READINESS_PATH?.trim() || '/bff/health/ready';
const requestUrl = target(baseUrl, requestPath);
const readinessUrl = target(baseUrl, readinessPath);

async function measuredFetch(url) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status, latencyMs: performance.now() - started };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.name : 'Error',
    };
  }
}

const readiness = await measuredFetch(readinessUrl);
if (!readiness.ok) {
  throw new Error(`readiness gate failed with HTTP ${readiness.status || 'network-error'}`);
}

const probe = await measuredFetch(requestUrl);
if (!probe.ok) {
  throw new Error(`authenticated read gate failed with HTTP ${probe.status || 'network-error'}`);
}

const latencies = [];
const statusCounts = new Map();
const errorTypes = new Map();
const startedAt = new Date();
const started = performance.now();
const deadline = started + durationSeconds * 1_000;

async function worker() {
  while (performance.now() < deadline) {
    const result = await measuredFetch(requestUrl);
    latencies.push(result.latencyMs);
    statusCounts.set(String(result.status), (statusCounts.get(String(result.status)) ?? 0) + 1);
    if (result.error) errorTypes.set(result.error, (errorTypes.get(result.error) ?? 0) + 1);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const completedAt = new Date();
const elapsedSeconds = (performance.now() - started) / 1_000;
const sorted = [...latencies].sort((a, b) => a - b);
const errors = [...statusCounts].reduce((sum, [status, count]) => {
  const numeric = Number(status);
  return sum + (numeric >= 200 && numeric < 400 ? 0 : count);
}, 0);
const errorRate = latencies.length ? errors / latencies.length : 1;
const p95Ms = percentile(sorted, 0.95);
const gates = {
  minimumRequests: latencies.length >= minimumRequests,
  maximumP95Ms: p95Ms !== null && p95Ms <= maximumP95Ms,
  maximumErrorRate: errorRate <= maximumErrorRate,
  noAuthenticationFailures: !statusCounts.has('401') && !statusCounts.has('403'),
};
const passed = Object.values(gates).every(Boolean);

const report = {
  schemaVersion: 1,
  kind: 'sentinel-production-authenticated-read-soak',
  passed,
  targetOrigin: baseUrl.origin,
  requestPath,
  readinessPath,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  configuration: { durationSeconds, concurrency, timeoutMs, minimumRequests, maximumP95Ms, maximumErrorRate },
  results: {
    requests: latencies.length,
    errors,
    errorRate,
    requestsPerSecond: latencies.length / elapsedSeconds,
    latencyMs: {
      min: sorted[0] ?? null,
      p50: percentile(sorted, 0.5),
      p95: p95Ms,
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? null,
    },
    statusCounts: Object.fromEntries([...statusCounts].sort()),
    errorTypes: Object.fromEntries([...errorTypes].sort()),
  },
  gates,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.SENTINEL_REPORT_PATH?.trim()) {
  await writeFile(process.env.SENTINEL_REPORT_PATH.trim(), serialized, { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(serialized);
if (!passed) process.exitCode = 1;
