#!/bin/bash
#
# TripForge — single-entry test runner.
#
# This script is the only command a reviewer needs:
#
#   ./run_tests.sh            # reuse healthy containers when possible
#   ./run_tests.sh --fresh    # always start from a wiped DB volume
#   ./run_tests.sh -h         # help
#
# It detects the current state of the compose stack and brings it up
# automatically, waits for the API to be healthy, then runs the unit
# and API test suites inside the container and prints a summary.
# Reviewers never have to run `docker compose up` by hand or export
# any environment variable — `docker-compose.yml` ships TEST_ONLY
# inline credentials so a fresh clone boots from `./run_tests.sh`
# alone, with no `.env` file involved.
#
# State machine:
#   • --fresh           → unconditional down -v + up --build (stable runs)
#   • not running       → down -v + up --build
#   • running but sick  → down -v + up --build
#   • running + healthy → reuse, skip startup
#
# --fresh is the recommended flag for CI / cross-session runs: it
# guarantees identical starting state by wiping the mysqldata volume
# before booting. Local iterative development can omit it for speed.

set -e

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh)
      FRESH=1
      ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (try --help)" >&2
      exit 64
      ;;
  esac
done

HEALTH_URL="http://localhost:3000/health"
MAX_WAIT=180

cd "$(dirname "$0")"

# ──────────────────────────────────────────────────────────────────────────
# Step 1 — Ensure the Docker stack is up
#
# We always wipe the `mysqldata` volume on a cold start (`down -v`) so
# every bring-up runs against a fresh database. Otherwise stale state
# from a previous build — users seeded under a different schema, leaked
# credentials, half-rolled-back migrations, etc. — can flake one or two
# API tests on the next run, even though the containers themselves come
# up cleanly. The volume reset is the same trick w2t52 uses with
# `reset_db` between suites.
#
# State machine:
#   • not running       → down -v + build + start API and DB
#   • running but sick  → down -v + build + start API and DB
#   • running + healthy → reuse, skip startup
# ──────────────────────────────────────────────────────────────────────────
api_running=$(docker compose ps --status running 2>/dev/null | grep -c "api" || true)
if [ "$FRESH" -eq 1 ]; then
  echo "[1/5] --fresh requested — forcing wiped DB + rebuild for a deterministic starting state..."
  docker compose down -v >/dev/null 2>&1 || true
  docker compose up -d --build
  echo "      Containers started from a clean slate."
elif [ "$api_running" -eq 0 ]; then
  echo "[1/5] Docker stack is down — wiping volumes and building from scratch..."
  docker compose down -v >/dev/null 2>&1 || true
  docker compose up -d --build
  echo "      Containers started."
else
  if ! docker compose exec -T api wget -qO- "$HEALTH_URL" >/dev/null 2>&1; then
    echo "[1/5] API is unresponsive — tearing down (with volumes) and rebuilding..."
    docker compose down -v
    docker compose up -d --build
    echo "      Containers rebuilt."
  else
    echo "[1/5] Docker stack already up and healthy — skipping startup (use --fresh to force a clean DB)."
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Step 2 — Wait for API health
# ──────────────────────────────────────────────────────────────────────────
echo "[2/5] Waiting for API..."
elapsed=0
while [ $elapsed -lt $MAX_WAIT ]; do
  if docker compose exec -T api wget -qO- "$HEALTH_URL" 2>/dev/null | grep -q '"status"'; then
    echo "      Ready (${elapsed}s)"
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
if [ $elapsed -ge $MAX_WAIT ]; then
  echo "ERROR: API not healthy after ${MAX_WAIT}s"
  docker compose logs --tail 50 api
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────
# Step 3 — Unit tests (inside container)
# ──────────────────────────────────────────────────────────────────────────
echo "[3/5] Unit tests..."
UNIT_EXIT=0
# --runInBand: single-threaded execution. Unit tests auto-mock Prisma and
# share the winston logger singleton across files; serialising eliminates
# the class of cross-worker flake the 2026-04 audit flagged.
docker compose exec -T api npx jest --testPathPattern=unit_tests --verbose --no-cache --runInBand 2>&1 || UNIT_EXIT=$?

# ──────────────────────────────────────────────────────────────────────────
# Step 4 — API tests (inside container)
# ──────────────────────────────────────────────────────────────────────────
echo "[4/5] API tests..."
API_EXIT=0
docker compose exec -T api npx jest --testPathPattern=API_tests --verbose --no-cache --runInBand 2>&1 || API_EXIT=$?

# ──────────────────────────────────────────────────────────────────────────
# Step 5 — Combined coverage + threshold gate (inside container)
#
# Runs both suites with --coverage and lets Jest enforce the thresholds
# declared in jest.config.js. The gate fails the whole run if coverage
# regresses below policy; that's exactly what a CI invocation of
# `./run_tests.sh` should do.
#
# We invoke jest with --runInBand so the API tests keep their database
# isolation guarantees when sharing the Jest worker with the unit suite.
# The coverage summary is printed to stdout; the full HTML report is
# materialised under repo/coverage/ for local inspection.
# ──────────────────────────────────────────────────────────────────────────
echo "[5/5] Coverage threshold gate..."
COV_EXIT=0
docker compose exec -T api npx jest \
    --coverage \
    --runInBand \
    --no-cache \
    --coverageReporters=text-summary \
    --coverageReporters=text \
    --coverageReporters=json-summary \
  2>&1 | tail -80 || COV_EXIT=$?

# ──────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
[ $UNIT_EXIT -eq 0 ] && echo "  Unit tests:   PASSED" || echo "  Unit tests:   FAILED"
[ $API_EXIT  -eq 0 ] && echo "  API tests:    PASSED" || echo "  API tests:    FAILED"
[ $COV_EXIT  -eq 0 ] && echo "  Coverage gate: PASSED" || echo "  Coverage gate: FAILED"
echo "========================================"
exit $((UNIT_EXIT + API_EXIT + COV_EXIT))
