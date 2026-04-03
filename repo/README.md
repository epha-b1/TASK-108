# TripForge

Offline-first backend API platform for travel itinerary planning, data ingestion, and model-assisted recommendations.

## Quick Start (Docker — primary path)

```bash
docker compose up --build
```

No `.env` file required. All configuration is in `docker-compose.yml`.

## Verification (Docker)

```bash
# Build and start
docker compose up -d --build

# Run unit tests (no DB needed)
docker compose exec -T api npm run test:unit -- --runInBand

# Run API tests (uses MySQL in compose network)
docker compose exec -T api npm run test:api -- --runInBand

# Health check
curl http://localhost:3000/health

# Full automated test suite
./run_tests.sh
```

## Ports

| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Swagger | http://localhost:3000/api/docs |
| MySQL | localhost:3306 |

## Test Credentials

| username | password |
|----------|----------|
| admin | Admin123!Admin |
| organizer | Organizer123! |

## Key API Behaviors

### Idempotency (mandatory)

All mutating endpoints (POST/PATCH/DELETE) **require** the `Idempotency-Key` header. Missing header returns 400 `MISSING_IDEMPOTENCY_KEY`. When provided:
- Same key + same actor + same payload = cached response replay
- Same key + different actor or payload = 409 IDEMPOTENCY_CONFLICT
- Keys expire after 24 hours
- Sensitive tokens (accessToken, refreshToken) are redacted in cached responses

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

Invalid payloads return 400 with structured details:
```json
{ "statusCode": 400, "code": "VALIDATION_ERROR", "message": "Request validation failed", "details": [...] }
```

### Model Inference Authorization

`POST /models/:id/infer` requires authentication **and** `model:read` permission.

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

10 failed login attempts within a rolling 15-minute window locks the account for 15 minutes. Failed attempts outside the window do not count.

## Local Development (optional, requires MySQL)

```bash
npm ci && npx prisma generate
export DATABASE_URL="mysql://tripforge:tripforge@localhost:3306/tripforge"
export JWT_SECRET="change_me_in_production"
export ENCRYPTION_KEY="change_me_32_chars_minimum_here_x"
npx prisma migrate deploy
npm run dev
```

## Local Test Run (without Docker)

```bash
export DATABASE_URL="mysql://tripforge:tripforge@localhost:3306/tripforge"
export JWT_SECRET="change_me_in_production"
export ENCRYPTION_KEY="change_me_32_chars_minimum_here_x"

npx prisma migrate deploy
npm run test:unit -- --runInBand
npx jest --testPathPattern=API_tests --runInBand
```

Note: `POST /import/upload` expects both:
- `Idempotency-Key` header (global mutating operation requirement)
- `idempotencyKey` multipart form field (import batch identity)
