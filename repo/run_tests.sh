#!/bin/sh
#
# TripForge — compose-based test runner.
#
# Wraps the canonical two-file compose invocation in a single command:
#
#   docker compose -f docker-compose.yml -f docker-compose.test.yml ...
#
# The base `docker-compose.yml` is production-shaped: it uses
# `${VAR:?...}` interpolation, which Docker Compose evaluates at file
# *parse* time (per file, before any -f override is merged). That means a
# missing `DATABASE_URL` in the host shell aborts compose before it ever
# looks at the override file's container `environment:` block.
#
# Fix: this script EXPORTS the same TEST_ONLY_NOT_FOR_PRODUCTION values
# the override file documents *before* it invokes compose, so the
# parse-time interpolation succeeds. The override file is still loaded
# (for NODE_ENV=test and to keep manual `docker compose ... -f` users in
# sync), but the secrets that satisfy `${VAR:?...}` come from these
# shell-level exports. There is intentionally NO `.env` file involved.
#
# Strict fail-fast posture: if any compose step fails the script exits
# immediately with a clear error instead of continuing into a useless
# health-check loop or running the test suite against a half-started stack.

set -eu

# ──────────────────────────────────────────────
# Step 0 — TEST_ONLY shell exports for compose interpolation.
# These MUST stay in sync with docker-compose.test.yml's environment
# block; both sources document the same values from different angles
# (shell-level for base-file interpolation, container-level for the
# running services). The strings are deliberately marked
# TEST_ONLY_NOT_FOR_PRODUCTION so a copy-paste into a real environment
# is unmistakable.
# ──────────────────────────────────────────────
export DATABASE_URL="mysql://tripforge:TEST_ONLY_NOT_FOR_PRODUCTION_db@db:3306/tripforge"
export JWT_SECRET="TEST_ONLY_NOT_FOR_PRODUCTION_jwt_secret_padding_to_64_chars_xx"
export ENCRYPTION_KEY="TEST_ONLY_NOT_FOR_PRODUCTION__32"
export MYSQL_USER="tripforge"
export MYSQL_PASSWORD="TEST_ONLY_NOT_FOR_PRODUCTION_db"
export MYSQL_DATABASE="tripforge"
export MYSQL_ROOT_PASSWORD="TEST_ONLY_NOT_FOR_PRODUCTION_root"
export NODE_ENV="test"

# ──────────────────────────────────────────────
# Canonical compose command — used for EVERY docker compose call below.
# Printed for transparency so reviewers can copy/paste it manually if
# this script ever needs to be bypassed.
# ──────────────────────────────────────────────
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.test.yml"
echo "[run_tests] compose command: ${COMPOSE}"

# ──────────────────────────────────────────────
# Preflight — make sure the docker daemon is reachable. If `docker info`
# fails the rest of the script can't possibly succeed, so bail out with
# a clear remediation hint instead of a noisy compose stacktrace.
# ──────────────────────────────────────────────
echo ""
echo "=== Preflight: docker daemon ==="
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' CLI is not installed on this host." >&2
  echo "       Install Docker Desktop / docker-engine and re-run." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not reachable." >&2
  echo "       Start it with one of:" >&2
  echo "         systemctl --user start docker-desktop   # Docker Desktop" >&2
  echo "         sudo systemctl start docker             # docker-engine on Linux" >&2
  echo "         open -a Docker                          # Docker Desktop on macOS" >&2
  exit 1
fi
echo "docker daemon OK."

# ──────────────────────────────────────────────
# Step 1 — Ensure containers are up
# ──────────────────────────────────────────────
echo ""
echo "=== Step 1: Ensuring containers are running ==="

api_running=$(${COMPOSE} ps --status running --format '{{.Service}}' 2>/dev/null | grep -c '^api$' || true)

if [ "$api_running" -eq 0 ]; then
  echo "API container is not running. Starting with build..."
  if ! ${COMPOSE} up -d --build; then
    echo ""
    echo "ERROR: '${COMPOSE} up -d --build' failed. Aborting." >&2
    echo "Last 30 lines of API logs (if any):" >&2
    ${COMPOSE} logs api --tail 30 >&2 || true
    exit 1
  fi
else
  # Container is running — verify it responds before trusting it
  if ! ${COMPOSE} exec -T api wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
    echo "API container is running but not responding. Restarting..."
    if ! ${COMPOSE} restart api; then
      echo "ERROR: '${COMPOSE} restart api' failed. Aborting." >&2
      exit 1
    fi
  else
    echo "API container is running and responding."
  fi
fi

# ──────────────────────────────────────────────
# Step 2 — Wait for API health
# ──────────────────────────────────────────────
echo ""
echo "=== Step 2: Waiting for API to be healthy ==="

attempts=0
max_attempts=60

# `set -e` would normally abort the script on the first failed health-check
# command inside the loop, so we explicitly tolerate the wget failure here.
while [ "$attempts" -lt "$max_attempts" ]; do
  if ${COMPOSE} exec -T api wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
    echo "API is healthy."
    break
  fi
  attempts=$((attempts + 1))
  printf "  waiting... (%d/%d)\n" "$attempts" "$max_attempts"
  sleep 1
done

if [ "$attempts" -ge "$max_attempts" ]; then
  echo "" >&2
  echo "ERROR: API did not become healthy within ${max_attempts}s." >&2
  echo "Last 30 lines of API logs:" >&2
  ${COMPOSE} logs api --tail 30 >&2 || true
  exit 1
fi

# ──────────────────────────────────────────────
# Step 3 — Unit tests
# ──────────────────────────────────────────────
echo ""
echo "=== Step 3: Running unit tests ==="

# Don't let `set -e` short-circuit the summary block — capture the exit
# code instead and decide at the end.
unit_exit=0
${COMPOSE} exec -T api npx jest --testPathPattern=unit_tests --verbose --no-cache || unit_exit=$?

# ──────────────────────────────────────────────
# Step 4 — API tests
# ──────────────────────────────────────────────
echo ""
echo "=== Step 4: Running API tests ==="

api_exit=0
${COMPOSE} exec -T api npx jest --testPathPattern=API_tests --verbose --no-cache --runInBand || api_exit=$?

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo "========================================"
echo "  TEST SUMMARY"
echo "========================================"

if [ "$unit_exit" -eq 0 ]; then
  echo "  Unit tests:  PASSED"
else
  echo "  Unit tests:  FAILED (exit $unit_exit)"
fi

if [ "$api_exit" -eq 0 ]; then
  echo "  API tests:   PASSED"
else
  echo "  API tests:   FAILED (exit $api_exit)"
fi

echo "========================================"

if [ "$unit_exit" -ne 0 ] || [ "$api_exit" -ne 0 ]; then
  exit 1
fi

exit 0
