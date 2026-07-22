#!/usr/bin/env bash
# Performance sweep: measure Core Web Vitals (LCP/CLS/FCP/TBT) + transfer weight per route
# inside the scanner container's Chromium against the internal web service. Exits non-zero if
# any route breaches the "good" thresholds — suitable for CI. Requires the stack to be up.
set -euo pipefail

docker compose cp scripts/perf-sweep.mjs scanner:/app/perf-sweep.mjs
docker compose exec -T -e BASE_URL="${BASE_URL:-http://web:3000}" scanner sh -c 'cd /app && node perf-sweep.mjs'
