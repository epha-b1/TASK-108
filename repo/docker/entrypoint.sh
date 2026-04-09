#!/usr/bin/env bash
# TripForge single-container entrypoint.
#
# Boots a local MariaDB instance, waits for it to be ready, runs Prisma
# migrations, then execs the supplied command (defaults to `node dist/server.js`).
#
# Required env vars (the API server itself also enforces these):
#   JWT_SECRET        — strong random string, >= 32 chars
#   ENCRYPTION_KEY    — exactly 32 chars
#
# Optional env vars (with sane defaults for the bundled DB):
#   MYSQL_DATABASE    — default tripforge
#   MYSQL_USER        — default tripforge
#   MYSQL_PASSWORD    — REQUIRED if you want a non-default DB password; auto-
#                       generated on first boot if unset and persisted in the
#                       data dir.
#   DATABASE_URL      — auto-derived from MYSQL_USER/MYSQL_PASSWORD when unset.
#   NODE_ENV          — defaults to production.

set -euo pipefail

DATA_DIR="/var/lib/mysql"
SOCKET="/run/mysqld/mysqld.sock"
RUN_DIR="/run/mysqld"
LOG_FILE="/var/log/mariadb.log"

MYSQL_DATABASE="${MYSQL_DATABASE:-tripforge}"
MYSQL_USER="${MYSQL_USER:-tripforge}"
NODE_ENV="${NODE_ENV:-production}"
export NODE_ENV

# ----- 1. Validate critical secrets BEFORE we touch the database --------------
if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "FATAL: JWT_SECRET is not set. Refusing to start." >&2
  echo "       Pass via -e JWT_SECRET=... (>= 32 chars, generate with openssl rand -hex 32)" >&2
  exit 1
fi
if [[ ${#JWT_SECRET} -lt 32 ]]; then
  echo "FATAL: JWT_SECRET is too short (${#JWT_SECRET} chars; require >= 32)." >&2
  exit 1
fi
if [[ -z "${ENCRYPTION_KEY:-}" ]]; then
  echo "FATAL: ENCRYPTION_KEY is not set. Refusing to start." >&2
  echo "       Pass via -e ENCRYPTION_KEY=... (exactly 32 chars)" >&2
  exit 1
fi
if [[ ${#ENCRYPTION_KEY} -ne 32 ]]; then
  echo "FATAL: ENCRYPTION_KEY must be exactly 32 chars (got ${#ENCRYPTION_KEY})." >&2
  exit 1
fi

# ----- 2. Initialise MariaDB data dir on first boot ---------------------------
mkdir -p "${RUN_DIR}"
chown -R mysql:mysql "${RUN_DIR}" "${DATA_DIR}"

if [[ ! -d "${DATA_DIR}/mysql" ]]; then
  echo "[entrypoint] Initialising MariaDB data dir at ${DATA_DIR}..."
  mysql_install_db --user=mysql --datadir="${DATA_DIR}" >/dev/null
fi

# Generate a random local DB password on first boot if none was supplied. We
# persist it in the data dir so subsequent boots reuse it. This is *only* used
# by the API connecting over a local unix socket — it never leaves the
# container — so it's safe to auto-generate.
PASSWORD_FILE="${DATA_DIR}/.tripforge_db_password"
if [[ -z "${MYSQL_PASSWORD:-}" ]]; then
  if [[ -f "${PASSWORD_FILE}" ]]; then
    MYSQL_PASSWORD="$(cat "${PASSWORD_FILE}")"
  else
    MYSQL_PASSWORD="$(openssl rand -hex 24)"
    echo -n "${MYSQL_PASSWORD}" > "${PASSWORD_FILE}"
    chmod 600 "${PASSWORD_FILE}"
    chown mysql:mysql "${PASSWORD_FILE}"
  fi
fi
export MYSQL_PASSWORD

# ----- 3. Start mariadbd in the background ------------------------------------
echo "[entrypoint] Starting MariaDB..."
mysqld --user=mysql --datadir="${DATA_DIR}" --socket="${SOCKET}" \
  --bind-address=127.0.0.1 --skip-name-resolve \
  >"${LOG_FILE}" 2>&1 &
MYSQLD_PID=$!

# ----- 4. Wait for ready ------------------------------------------------------
echo "[entrypoint] Waiting for MariaDB to accept connections..."
for i in $(seq 1 60); do
  if mysqladmin --socket="${SOCKET}" ping --silent 2>/dev/null; then
    echo "[entrypoint] MariaDB is ready (after ${i}s)."
    break
  fi
  if ! kill -0 "${MYSQLD_PID}" 2>/dev/null; then
    echo "FATAL: mysqld exited during startup. Last 50 log lines:" >&2
    tail -n 50 "${LOG_FILE}" >&2 || true
    exit 1
  fi
  sleep 1
done

if ! mysqladmin --socket="${SOCKET}" ping --silent 2>/dev/null; then
  echo "FATAL: MariaDB did not become ready within 60s." >&2
  tail -n 50 "${LOG_FILE}" >&2 || true
  exit 1
fi

# ----- 5. Bootstrap database + user (idempotent) ------------------------------
mysql --socket="${SOCKET}" -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
ALTER USER '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

# Prisma needs a TCP-style URL. Connect over 127.0.0.1 (we already bound there).
# Make mariadb listen on 127.0.0.1:3306 (default) so Prisma's mysql:// works.
if [[ -z "${DATABASE_URL:-}" ]]; then
  export DATABASE_URL="mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@127.0.0.1:3306/${MYSQL_DATABASE}"
fi

# ----- 6. Run migrations ------------------------------------------------------
echo "[entrypoint] Running prisma migrate deploy..."
cd /app
npx prisma migrate deploy

# Audit log immutability triggers are installed by the
# 20260409000000_audit_immutability Prisma migration, so both single-container
# and compose deployments inherit the protection automatically.

# ----- 7. Trap signals so mysqld is stopped cleanly on shutdown ----------------
trap 'echo "[entrypoint] shutting down..."; mysqladmin --socket="${SOCKET}" -uroot shutdown 2>/dev/null || true; wait "${MYSQLD_PID}" 2>/dev/null || true; exit 0' INT TERM

# ----- 8. exec the API --------------------------------------------------------
echo "[entrypoint] Starting application: $*"
exec "$@"
