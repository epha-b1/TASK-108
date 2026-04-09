# TripForge

Offline-first backend API platform for travel itinerary planning, data ingestion, and model-assisted recommendations.

---

## Quick Start — Single-Container (acceptance path)

The acceptance deployment is one container that bundles the API and a local
MariaDB instance. Provide the two required secrets and run:

```bash
docker build -t tripforge .

docker run --rm -p 3000:3000 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ENCRYPTION_KEY=$(openssl rand -base64 24 | cut -c1-32) \
  -v tripforge_data:/var/lib/mysql \
  tripforge
```

The container's entrypoint:

1. Validates `JWT_SECRET` (>= 32 chars) and `ENCRYPTION_KEY` (exactly 32 chars) — fails fast otherwise.
2. Initialises MariaDB on first boot, persisting data to the `/var/lib/mysql` volume.
3. Runs `prisma migrate deploy` (which installs the audit-log immutability triggers).
4. Starts the API on port 3000.

Health check: `curl http://localhost:3000/health`

> **Why no insecure defaults?** Both `JWT_SECRET` and `ENCRYPTION_KEY` are required.
> The server refuses to start if either is missing, weak, or set to a known
> placeholder. There is no `change_me_in_production` fallback anywhere.

---

## Local Development (compose, separate API + MySQL)

The compose path is for development only. It runs the API and a separate
MySQL container so you can iterate without rebuilding the bundled image.

```bash
cp .env.example .env
# Generate strong secrets and replace the placeholders in .env:
sed -i "s|REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS_FROM_OPENSSL|$(openssl rand -hex 32)|" .env
sed -i "s|REPLACE_WITH_EXACTLY_32_RANDOM_CHARS_|$(openssl rand -base64 24 | cut -c1-32)|" .env

docker compose up -d --build
docker compose exec -T api npm run test:unit -- --runInBand
docker compose exec -T api npx jest --testPathPattern=API_tests --runInBand
```

`docker compose up` will refuse to start if any of `JWT_SECRET`,
`ENCRYPTION_KEY`, `DATABASE_URL`, `MYSQL_USER`, `MYSQL_PASSWORD`, or
`MYSQL_ROOT_PASSWORD` is missing.

---

## Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | At least 32 characters. Generate with `openssl rand -hex 32`. |
| `ENCRYPTION_KEY` | ✅ | Exactly 32 characters. Used to derive the AES-256 key for security-question encryption. |
| `DATABASE_URL` | ✅ in non-test runtimes | `mysql://user:pass@host:3306/dbname`. The single-container image auto-derives this from `MYSQL_USER`/`MYSQL_PASSWORD`. |
| `ACCESS_TOKEN_TTL` | optional | Seconds. Default 1800 (30 min). |
| `REFRESH_TOKEN_TTL` | optional | Seconds. Default 1209600 (14 days). |
| `PORT` | optional | Default 3000. |
| `NODE_ENV` | optional | Default `production`. Set to `test` only for the unit/API test suites. |

The server validates all of these at startup. Setting any of them to a known
placeholder (`change_me_in_production`, `secret`, etc.) is rejected with a
clear error message regardless of `NODE_ENV`.

---

## Verification

```bash
# Single-container build + smoke test
docker build -t tripforge .
docker run --rm -d -p 3000:3000 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ENCRYPTION_KEY=$(openssl rand -base64 24 | cut -c1-32) \
  --name tripforge-smoke tripforge
# wait for /health
curl -s http://localhost:3000/health

# Compose-based dev test runner
./run_tests.sh
```

## Ports

| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Swagger | http://localhost:3000/api/docs |
| MySQL (compose only) | localhost:3306 |

## Test Credentials (after `prisma seed`)

| username | password |
|----------|----------|
| admin | Admin123!Admin |
| organizer | Organizer123! |

---

## Key API Behaviours

### Canonical error envelope

Every non-2xx response returns:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "requestId": "11111111-2222-3333-4444-555555555555",
  "details": [...]
}
```

`requestId` is the canonical correlation field and always equals the
`X-Request-Id` response header. The header `X-Trace-Id` and the body field
`traceId` are kept temporarily as backwards-compatible aliases — new clients
should use `requestId` only.

If a client supplies `X-Request-Id` (or the legacy `X-Trace-Id`) on the
request, the server echoes that exact value back instead of generating one.

### Idempotency (mandatory)

All mutating endpoints (POST/PATCH/DELETE) **require** the `Idempotency-Key`
header. Missing header returns `400 MISSING_IDEMPOTENCY_KEY`. When provided:

- Same key + same actor + same payload → cached response is replayed.
- Same key + different actor → fresh execution under the new identity (no replay, no overwrite).
- Same key + same actor but different payload → `409 IDEMPOTENCY_CONFLICT`.
- Forged / invalid bearer token → request is allowed to fall through to auth, which then returns `401`.
- Keys expire after 24 hours.
- Sensitive tokens (`accessToken`, `refreshToken`) are redacted in cached responses.

### Resource type enum (canonical)

The four canonical resource types are `attraction | lodging | meal | meeting`.
This is enforced uniformly by:

- `POST /resources` and `PATCH /resources/{id}` validation
- `POST /import/upload` row-level validation (legacy values like `restaurant`,
  `hotel`, `transport`, `activity` are now rejected as `VALIDATION_ERROR` row
  errors instead of being silently committed)
- `GET /resources?type=...` filter

### Itinerary versioning

Each itinerary version snapshot captures BOTH itinerary metadata
(`title`, `destination`, `startDate`, `endDate`, `status`, `id`, `ownerId`)
and items. The `diffMetadata` records both metadata changes and
item-level adds / removes / modifies, so a status-only PATCH is a no-op
(no version cut) but renaming or rescheduling cuts a new version with a
metadata diff entry.

### Audit log immutability

Audit rows are append-only at the database layer. The
`20260409000000_audit_immutability` Prisma migration installs `BEFORE UPDATE`
and `BEFORE DELETE` triggers on `audit_logs` that raise `SQLSTATE 45000`,
so even an attacker holding the application DB credentials cannot tamper with
or erase historical audit rows. Both the single-container and compose
deployments inherit this protection automatically through `prisma migrate
deploy`.

### Model Adapter Mode

- `NODE_ENV=production`: defaults to `process` mode (real PMML/ONNX/custom subprocess execution; fails fast if binaries unavailable)
- `NODE_ENV=test` or unset: defaults to `mock` mode (deterministic mock inference)
- Override with `MODEL_ADAPTER_MODE=mock|process`

### Request Validation

Zod request validation is enabled on:
- Auth: register/login/refresh/recover/change-password
- Resources: create/hours/closures/travel-times
- Models: register/status/allocation/infer
- Itineraries: create/update/add-item/update-item
- Notifications: send/template-create/template-update
- Import: upload (entityType, idempotencyKey fields), commit/rollback (batchId UUID param)

### Endpoint auth rules (audit-flagged)

- `GET /import/templates/:entityType` is **public** (templates carry no
  sensitive data and are needed before a client has a token).
- `POST /users` does not exist. Self-registration is `POST /auth/register`;
  admin promotion happens via `PATCH /users/:id` on an existing account.
- `POST /models/:id/infer` requires authentication AND the `model:read` permission.

### Unusual-Location Challenge

When `lastKnownCity` changes on a known device during login:
1. Server returns 429 with `{ challengeToken, retryAfterSeconds: 300 }`
2. Client re-submits login with the `challengeToken` field
3. Max 3 challenges per user+device per rolling hour

### Device Limit

Max 5 active devices per user. 6th login returns:
```json
{
  "statusCode": 409,
  "code": "DEVICE_LIMIT_REACHED",
  "message": "Maximum 5 devices allowed. Remove a device first.",
  "details": { "devices": [...] }
}
```

### Lockout

10 failed login attempts within a rolling 15-minute window locks the account
for 15 minutes. Failed attempts outside the window do not count.

---

## Contract sync

`docs/api-spec.md` and `src/config/swagger.ts` are kept in sync by the
`unit_tests/contract_sync.spec.ts` test. Adding or changing an endpoint in
one file without updating the other causes the unit test suite to fail.

---

## Run all tests

```bash
# Unit tests (no DB)
npm run test:unit -- --runInBand

# API tests (uses MySQL via compose network)
docker compose exec -T api npx jest --testPathPattern=API_tests --runInBand
```

`POST /import/upload` expects both:
- `Idempotency-Key` header (global mutating-operation requirement)
- `idempotencyKey` multipart form field (import batch identity)
