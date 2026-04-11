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

The compose path runs the API and a separate MySQL container so you can
iterate without rebuilding the bundled single-container image.

There is **no `.env` file** in this repo. The default `docker-compose.yml`
is fully self-bootstrapping: every required value uses
`${VAR:-TEST_ONLY_NOT_FOR_PRODUCTION_default}` interpolation, so a bare
`docker compose up --build` from a fresh clone succeeds out of the box
with zero host-env preamble. All defaults are clearly marked
`TEST_ONLY_NOT_FOR_PRODUCTION` so they are unmistakable if copy-pasted
into a real deployment.

**Bare bring-up** (dev / CI smoke):

```bash
docker compose up -d --build
```

**Production-shape bring-up** (override every secret via host env):

```bash
DATABASE_URL=mysql://tripforge:PASS@db:3306/tripforge \
JWT_SECRET=$(openssl rand -hex 32) \
ENCRYPTION_KEY=$(openssl rand -base64 24 | cut -c1-32) \
MYSQL_USER=tripforge \
MYSQL_PASSWORD=PASS \
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24) \
NODE_ENV=production \
docker compose up -d --build
```

The application server at `src/config/environment.ts` still rejects known
weak placeholders (`changeme`, `secret`, `change_me_in_production`, etc.)
regardless of `NODE_ENV`, so a naive copy-paste of the `${VAR:-default}`
literal into a real secret store would not bypass the runtime check.

### Test / CI override (`docker-compose.test.yml`)

For the unit + API test suites we ship a separate override file. It
opts the stack into `NODE_ENV=test`, layers in throwaway credentials
clearly marked `TEST_ONLY_NOT_FOR_PRODUCTION`, and lets reviewers run
the suites in one command — no host env exports, no `.env` file:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.test.yml \
  exec -T api npm run test:unit -- --runInBand
docker compose -f docker-compose.yml -f docker-compose.test.yml \
  exec -T api npx jest --testPathPattern=API_tests --runInBand
```

The compose file maps host port **3010** → container port 3000 so it
coexists with any other local service that already binds 3000. The
override exists so the *default* compose path stays production-shaped
and rejects ad-hoc startup, while reviewers still have a one-command
test rig. For the truly single-container production path see the
*Quick Start* section above.

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
```

### Test suites (compose-based, no `.env`)

The official test commands always pass **both** compose files. The default
`docker-compose.yml` is production-shaped and refuses to start without
host-environment secrets; the `docker-compose.test.yml` override layers in
the throwaway `TEST_ONLY_NOT_FOR_PRODUCTION` credentials and switches
`NODE_ENV=test`. There is no `.env` file involved.

The recommended invocation is the bundled `run_tests.sh` script, which
wraps the canonical two-file compose command, brings the stack up,
waits for the API to be healthy, runs both test suites, and prints a
summary. It exits non-zero immediately if compose startup fails so you
never end up running tests against a half-started stack.

```bash
./run_tests.sh
```

If you need to run the steps manually (e.g. to iterate on a single
test file inside the container) you must first export the same
TEST_ONLY shell variables that `run_tests.sh` exports — Docker Compose
evaluates `${VAR:?...}` in the base file at parse time, *before* the
override file's container `environment:` block is merged, so the
override alone is not enough.

```bash
# TEST_ONLY shell exports — kept in sync with docker-compose.test.yml.
# Never use these values in a real environment.
export DATABASE_URL="mysql://tripforge:TEST_ONLY_NOT_FOR_PRODUCTION_db@db:3306/tripforge"
export JWT_SECRET="TEST_ONLY_NOT_FOR_PRODUCTION_jwt_secret_padding_to_64_chars_xx"
export ENCRYPTION_KEY="TEST_ONLY_NOT_FOR_PRODUCTION__32"
export MYSQL_USER="tripforge"
export MYSQL_PASSWORD="TEST_ONLY_NOT_FOR_PRODUCTION_db"
export MYSQL_DATABASE="tripforge"
export MYSQL_ROOT_PASSWORD="TEST_ONLY_NOT_FOR_PRODUCTION_root"
export NODE_ENV="test"

# Bring the test stack up
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build

# Wait for the API to be healthy
docker compose -f docker-compose.yml -f docker-compose.test.yml \
  exec -T api wget -qO- http://localhost:3000/health

# Unit tests
docker compose -f docker-compose.yml -f docker-compose.test.yml \
  exec -T api npm run test:unit -- --runInBand

# API integration tests
docker compose -f docker-compose.yml -f docker-compose.test.yml \
  exec -T api npx jest --testPathPattern=API_tests --runInBand --no-cache

# Tear down when done
docker compose -f docker-compose.yml -f docker-compose.test.yml down -v
```

## Ports

| Service | URL |
|---------|-----|
| API (single-container) | http://localhost:3000 |
| API (compose dev rig)  | http://localhost:3010 |
| Swagger (single-container) | http://localhost:3000/api/docs |
| MySQL (compose only) | localhost:3306 |

## Test Credentials (after `prisma seed`)

| username | password |
|----------|----------|
| admin | Admin123!Admin |
| organizer | Organizer123! |

---

## Key API Behaviours

### Canonical error envelope

Every non-2xx response — **including both branches of HTTP 429** — returns:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "requestId": "11111111-2222-3333-4444-555555555555",
  "details": [...]
}
```

The two HTTP 429 paths are explicit and distinct:

| Branch | `code` | Extras |
|---|---|---|
| Unusual-location challenge issued | `CHALLENGE_REQUIRED` | `challengeToken`, `retryAfterSeconds` at top level (preserved for existing clients) |
| 4th challenge inside the rolling hour | `RATE_LIMITED` | no `challengeToken`; `message` mentions retry timing |

In all cases the body's `requestId` is identical to the `X-Request-Id`
response header. The parameterised contract is enforced by
`API_tests/envelope.api.spec.ts` and the dedicated 429 suite at
`API_tests/rate_limit_envelope.api.spec.ts`.

`requestId` is the canonical correlation field and always equals the
`X-Request-Id` response header.

#### `traceId` / `X-Trace-Id` deprecation timeline

The body field `traceId` and the response header `X-Trace-Id` are kept as
deprecated aliases on the same value as `requestId` / `X-Request-Id`:

| Phase | TripForge release | Behaviour |
|---|---|---|
| **Now (deprecated alias)** | this release | Both fields/headers are written on every response and the server still accepts incoming `X-Trace-Id` request headers. Logs warn callers to migrate. |
| **Removal** | the next major release after every documented client has migrated | Server stops writing `traceId` in error bodies and stops sending `X-Trace-Id`; the request-side alias is still accepted for one further release. |
| **Final** | one release after Removal | All `trace*` aliases are dropped from request and response paths. |

New clients **must** use `requestId` / `X-Request-Id` only. The contract test
at `unit_tests/contract_sync.spec.ts` enforces that the canonical field is the
required field in the OpenAPI `Error` schema.

If a client supplies `X-Request-Id` (or, during the deprecation window, the
legacy `X-Trace-Id`) on the request, the server echoes that exact value back
instead of generating one.

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

Per the prompt requirement "every save creates a versioned revision record",
every PATCH to an itinerary cuts a new version — including status-only
lifecycle transitions (`draft → published → archived`).

Each version snapshot captures BOTH itinerary metadata
(`title`, `destination`, `startDate`, `endDate`, `status`, `id`, `ownerId`)
and items. The `diffMetadata` records both metadata changes and item-level
adds / removes / modifies. A status-only PATCH produces a version whose
`diffMetadata.metadata` contains a single `status` entry, so consumers
can still distinguish lifecycle transitions from content edits.

### Audit log immutability

Audit rows are append-only at the database layer. The
`20260409000000_audit_immutability` Prisma migration installs `BEFORE UPDATE`
and `BEFORE DELETE` triggers on `audit_logs` that raise `SQLSTATE 45000`,
so even an attacker holding the application DB credentials cannot tamper with
or erase historical audit rows. Both the single-container and compose
deployments inherit this protection automatically through `prisma migrate
deploy`.

### Model Adapter Mode

- `NODE_ENV=production`: defaults to `process` mode (real PMML/Custom subprocess execution; fails fast if binaries unavailable)
- `NODE_ENV=test` or unset: defaults to `mock` mode (deterministic mock inference)
- Override with `MODEL_ADAPTER_MODE=mock|process`

#### Runtime requirements for `process` mode

The bundled single-container image (Dockerfile) installs:

| Adapter | Binary | Alpine package | Allowlist entry | Out-of-the-box? |
|---|---|---|---|---|
| PMML / `pmml` | `/usr/bin/java` (symlink) | `openjdk17-jre-headless` | `/usr/bin/java` | ✅ runs, given a valid `.jar` / `.pmml` model |
| ONNX / `onnx` | `/usr/bin/python3` | `python3`, `py3-pip` | `/usr/bin/python3` | ⚠️ python3 only — `onnxruntime` is **not** bundled (see below) |
| Custom / `custom` | one of the above | — | strict allowlist | ✅ runs, given an allowlisted command |

**ONNX runtime — operator-provided boundary (intentional).** The `onnxruntime`
Python package is **not** bundled in the official image:

- Alpine has no upstream `onnxruntime` binary wheel; bundling it would
  either require switching the entire base image away from `node:20-alpine`
  or building from source, both of which significantly bloat the image.
- The boundary is therefore drawn at "we install python3, you install the
  runtime if you need it".

If an operator points the model registry at an ONNX model and the package
is not present, `POST /models/{id}/infer` returns a canonical error envelope:

```json
{
  "statusCode": 503,
  "code": "MODEL_RUNTIME_UNAVAILABLE",
  "message": "ONNX inference is unavailable: the `onnxruntime` Python package is not installed in the API container. ...",
  "requestId": "..."
}
```

Remediation options:

1. `pip install onnxruntime` inside the container (or in a derived image
   layer), then restart the API. The bundled `python3` is glibc-via-alpine
   so a custom build/wheel may be required.
2. Bake `onnxruntime` into a derived image: start `FROM tripforge` and add
   the wheel via your platform's package manager.
3. Set `MODEL_ADAPTER_MODE=mock` to fall back to deterministic mock
   inference for development / acceptance tests.

PMML and Custom adapter paths are unaffected — they work out of the box
because Java + python3 are both bundled. The static code path that surfaces
the missing-runtime AppError is exercised by
`unit_tests/model_security.spec.ts`.

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

### Structured logs — `category` field

Every meaningful structured log line carries a stable `category` field drawn
from a closed taxonomy, so observability tooling can filter and alert by
domain without parsing free text:

| Category | Emitted from |
|---|---|
| `request` | HTTP request-completion lines from `auditMiddleware` |
| `auth` | Login, logout, password change, challenge, device flows |
| `rbac` | Role / permission point / menu / user-role mutations |
| `itinerary` | Itinerary CRUD, items, versions, sharing, optimisation |
| `resource` | Resource CRUD, hours, closures, travel times |
| `import` | Bulk import upload / commit / rollback |
| `model` | Model registry + inference adapter events (raw input keys only — no PII payloads) |
| `notification` | Notification send + outbox processor + template ops |
| `audit` | Audit-row write failures (the rows themselves live in `audit_logs`) |
| `system` | Startup, shutdown, scheduler, unhandled errors, idempotency middleware errors |

The set is enforced by `src/utils/logger.ts:LOG_CATEGORIES`. Domain code
**must** use one of the pre-bound category loggers (`authLog`, `requestLog`,
…) or `categoryLogger('<name>')`; calling the raw `logger` directly is
discouraged. The contract is locked by `unit_tests/logger_category.spec.ts`,
which captures live log entries through a stream transport and asserts the
field on every category plus on the request-completion middleware and the
global error handler.

Sensitive-data hygiene is preserved: passwords, access/refresh tokens,
encrypted security-question answers, and raw model inference inputs are
**never** logged. Inference logs record only `inputKeys` (key names) and a
`hasContext` flag.

---

## Contract sync

The OpenAPI contract has two locations that MUST stay in sync:

- `../docs/api-spec.md` — the canonical human-curated reference document at
  the project root (one directory above `repo/`).
- `repo/src/config/swagger.ts` — the live OpenAPI object served at `/api/docs`.

`unit_tests/contract_sync.spec.ts` parses both and asserts they describe the
same set of endpoints, so adding or changing an operation in one file
without updating the other fails the unit test suite. The test must be run
from a checkout that includes the project-root `docs/` (host or CI). It is
**not** runnable from inside the built Docker image, whose build context is
`repo/` and intentionally does not bundle the docs directory.

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
