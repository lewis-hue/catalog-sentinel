#!/usr/bin/env bash
# Accessibility sweep: run axe-core over every app route inside the scanner container
# (which ships Playwright + Chromium) against the internal web service. Exits non-zero
# if any serious/critical WCAG 2.1 A/AA violation is found - suitable for CI.
#
# Prereq: the compose stack is up (docker compose up -d) and axe-core is installed
# (npm i, it's a devDependency of @sentinel/web).
set -euo pipefail

docker compose cp node_modules/axe-core/axe.min.js scanner:/app/axe.min.js
docker compose cp scripts/a11y-sweep.mjs scanner:/app/a11y-sweep.mjs
docker compose exec -T -e BASE_URL="${BASE_URL:-http://web:3000}" scanner sh -c 'cd /app && node a11y-sweep.mjs'
