# TripForge — Design Document

## 1. Overview

TripForge is an offline-first backend API platform for travel itinerary planning, data ingestion, and model-assisted recommendations. No UI. Pure REST API built with Express (TypeScript) + Prisma + MySQL. Runs on a single Docker host with no external connectivity.

---

## 2. Architecture

```
HTTP Client (Postman / frontend)
  │
  ▼
Express HTTP Server (port 3000)
  ├── Global Error Handler          → structured JSON errors
  ├── Request ID Middleware         → X-Request-Id on every request
  ├── JWT Auth Middleware           → validates Bearer token
  ├── RBAC Middleware               → permission-point enforcement
  ├── Idempotency Middleware        → deduplication for mutating ops
  ├── Audit Middleware              → append-only audit trail
  └── Domain Controllers/Services
        │
        ▼
   Prisma ORM layer
        │
        ▼
   MySQL 8 (port 3306)
```

---

## 3. Technology Stack

| Layer | Choice |
|---|---|
| HTTP framework | Express (TypeScript) |
| ORM | Prisma |
| Database | MySQL 8 |
| Auth | JWT (local, no external IdP) |
| Password hashing | bcrypt (rounds=12) |
| Field encryption | AES-256-GCM |
| Validation | zod |
| Scheduling | node-cron |
| API docs | Swagger UI (swagger-ui-express + openapi spec) |
| Logging | Winston with structured JSON |
| Excel/CSV | exceljs + csv-parse |
| Container | Docker + docker-compose |

---

## 4. Module Responsibilities

| Module | Responsibility |
|---|---|
| `auth` | Login, JWT, refresh tokens, device registration, unusual-location detection |
| `users` | User CRUD, password policy, account lockout, security questions |
| `rbac` | Roles, permission points, menu groupings, role bindings |
| `itineraries` | Itinerary CRUD, versioning, day-slot management, conflict validation |
| `resources` | Attractions, lodging, meals, meetings; business hours, closures |
| `routing` | Route optimization heuristics, explainable ranked suggestions |
| `import` | Excel/CSV bulk import, pre-validation, row-level errors, rollback |
| `models` | ML model registry, semantic versioning, A/B allocations, inference |
| `notifications` | Local in-app notifications, templates, retry, frequency caps |
| `audit` | Append-only audit log, immutable records |
| `common` | Middleware, encryption, error handling, idempotency |

---

## 5. Data Model

### Auth and Identity

```
users
  id            varchar(36) PK
  username      varchar(255) UNIQUE NOT NULL
  password_hash varchar(255) NOT NULL          -- bcrypt rounds=12
  status        enum NOT NULL                  -- active | suspended | locked
  last_login_at datetime
  failed_attempts int DEFAULT 0
  locked_until  datetime
  created_at    datetime
  updated_at    datetime

security_questions
  id          varchar(36) PK
  user_id     varchar(36) FK users
  question    text NOT NULL
  answer_hash text NOT NULL                    -- AES-256-GCM encrypted

devices
  id                 varchar(36) PK
  user_id            varchar(36) FK users
  device_fingerprint varchar(255) NOT NULL     -- hashed
  last_seen_at       datetime NOT NULL
  last_known_city    varchar(255)
  created_at         datetime
  UNIQUE (user_id, device_fingerprint)

refresh_tokens
  id         varchar(36) PK
  user_id    varchar(36) FK users
  device_id  varchar(36) FK devices
  token_hash varchar(255) NOT NULL
  expires_at datetime NOT NULL
  revoked_at datetime
  created_at datetime
```

### RBAC

```
roles
  id          varchar(36) PK
  name        varchar(255) UNIQUE NOT NULL
  description text
  created_at  datetime

permission_points
  id          varchar(36) PK
  code        varchar(255) UNIQUE NOT NULL     -- e.g. itinerary:read
  description text

menus
  id          varchar(36) PK
  name        varchar(255) UNIQUE NOT NULL     -- logical capability bundle
  description text

menu_permission_points
  menu_id            varchar(36) FK menus
  permission_point_id varchar(36) FK permission_points
  PRIMARY KEY (menu_id, permission_point_id)

role_permission_points
  role_id            varchar(36) FK roles
  permission_point_id varchar(36) FK permission_points
  PRIMARY KEY (role_id, permission_point_id)

user_roles
  user_id    varchar(36) FK users
  role_id    varchar(36) FK roles
  PRIMARY KEY (user_id, role_id)
```

### Itineraries

```
itineraries
  id          varchar(36) PK
  owner_id    varchar(36) FK users
  title       varchar(255) NOT NULL
  destination varchar(255)
  start_date  date
  end_date    date
  status      enum DEFAULT draft              -- draft | published | archived
  share_token varchar(255) UNIQUE
  share_expires_at datetime
  created_at  datetime
  updated_at  datetime

itinerary_versions
  id             varchar(36) PK
  itinerary_id   varchar(36) FK itineraries
  version_number int NOT NULL
  snapshot       json NOT NULL               -- full itinerary state
  diff_metadata  json                        -- what changed from previous
  created_by     varchar(36) FK users
  created_at     datetime
  UNIQUE (itinerary_id, version_number)

itinerary_items
  id              varchar(36) PK
  itinerary_id    varchar(36) FK itineraries
  resource_id     varchar(36) FK resources
  day_number      int NOT NULL
  start_time      time NOT NULL
  end_time        time NOT NULL
  notes           text
  position        int NOT NULL
  created_at      datetime
```

### Resources

```
resources
  id           varchar(36) PK
  name         varchar(255) NOT NULL
  type         enum NOT NULL                  -- attraction | lodging | meal | meeting
  street_line  varchar(255)
  city         varchar(255)
  region       varchar(255)
  country      varchar(255)
  latitude     decimal(10,7)
  longitude    decimal(10,7)
  min_dwell_minutes int DEFAULT 30
  created_at   datetime
  updated_at   datetime

resource_hours
  id          varchar(36) PK
  resource_id varchar(36) FK resources
  day_of_week int NOT NULL                   -- 0=Sun, 6=Sat
  open_time   time NOT NULL
  close_time  time NOT NULL

resource_closures
  id          varchar(36) PK
  resource_id varchar(36) FK resources
  date        date NOT NULL
  reason      varchar(255)

travel_time_matrices
  id              varchar(36) PK
  from_resource_id varchar(36) FK resources
  to_resource_id   varchar(36) FK resources
  travel_minutes   int NOT NULL
  transport_mode   enum DEFAULT walking       -- walking | driving | transit
  updated_at       datetime
```

### Import

```
import_batches
  id              varchar(36) PK
  user_id         varchar(36) FK users
  entity_type     varchar(100) NOT NULL
  status          enum DEFAULT pending        -- pending | processing | completed | failed | rolled_back
  total_rows      int DEFAULT 0
  success_rows    int DEFAULT 0
  error_rows      int DEFAULT 0
  idempotency_key varchar(255) UNIQUE NOT NULL
  rollback_until  datetime NOT NULL           -- created_at + 10 min
  created_at      datetime
  completed_at    datetime

import_errors
  id          varchar(36) PK
  batch_id    varchar(36) FK import_batches
  row_number  int NOT NULL
  field       varchar(255)
  message     text NOT NULL
  raw_data    json
```

### Models

```
ml_models
  id              varchar(36) PK
  name            varchar(255) NOT NULL
  version         varchar(50) NOT NULL        -- semver
  type            enum NOT NULL               -- pmml | onnx | custom
  status          enum DEFAULT inactive       -- inactive | active | canary
  file_path       varchar(500)
  config          json
  created_at      datetime
  UNIQUE (name, version)

ab_allocations
  id          varchar(36) PK
  model_id    varchar(36) FK ml_models
  group_name  varchar(100) NOT NULL
  percentage  decimal(5,2) NOT NULL
  created_at  datetime
```

### Notifications

```
notification_templates
  id        varchar(36) PK
  code      varchar(255) UNIQUE NOT NULL
  subject   varchar(500)
  body      text NOT NULL                     -- supports {{variable}} placeholders
  created_at datetime

notifications
  id           varchar(36) PK
  user_id      varchar(36) FK users
  template_id  varchar(36) FK notification_templates (nullable)
  type         varchar(100) NOT NULL
  subject      varchar(500)
  message      text NOT NULL
  read         boolean DEFAULT false
  delivered    boolean DEFAULT false
  retry_count  int DEFAULT 0
  next_retry_at datetime
  created_at   datetime

outbox_messages
  id           varchar(36) PK
  notification_id varchar(36) FK notifications
  status       enum DEFAULT pending            -- pending | delivered | failed
  attempts     int DEFAULT 0
  last_error   text
  created_at   datetime
  delivered_at datetime

user_notification_settings
  user_id       varchar(36) PK FK users
  blacklisted   boolean DEFAULT false
  daily_cap     int DEFAULT 20
  updated_at    datetime
```

### Audit and Idempotency

```
audit_logs
  id            varchar(36) PK
  actor_id      varchar(36) FK users
  action        varchar(255) NOT NULL
  resource_type varchar(100)
  resource_id   varchar(36)
  detail        json
  request_id    varchar(36)
  ip_address    varchar(45)
  created_at    datetime NOT NULL
  -- INSERT only, no UPDATE/DELETE for app DB role

idempotency_keys
  key            varchar(255) PK
  operation_type varchar(100) NOT NULL
  response_body  json NOT NULL
  created_at     datetime NOT NULL
  expires_at     datetime NOT NULL             -- created_at + 24h
```

---

## 6. Key Flows

### JWT + Refresh Token Flow

```
1. POST /auth/login {username, password, deviceFingerprint, lastKnownCity}
2. Verify password (bcrypt)
3. Check account status (locked/suspended → 401/403)
4. Check device count ≤ 5, register device if new
5. Detect unusual location: compare lastKnownCity to device.last_known_city
6. If unusual: rate-limited challenge prompt (429 with challenge token)
7. Issue access token (30 min) + refresh token (14 days)
8. Store refresh token hash in DB
9. Return tokens

POST /auth/refresh {refreshToken}
1. Validate refresh token hash in DB
2. Check not revoked, not expired
3. Issue new access token
4. Return new access token
```

### Itinerary Conflict Validation

```
1. POST /itineraries/:id/items {resourceId, dayNumber, startTime, endTime}
2. Load all existing items for same day
3. Check overlap: new item start/end overlaps any existing item → 409
4. Check 15-min buffer: gap between adjacent items < 15 min → 409
5. Check resource business hours: item outside open hours → 400
6. Check resource closures: item on closure date → 400
7. Check min dwell time: duration < resource.min_dwell_minutes → 400
8. Check travel time: travel from previous item > available gap → 409
9. INSERT itinerary_item
10. Create new itinerary_version with diff metadata
```

### Route Optimization

```
1. GET /itineraries/:id/optimize
2. Load all items for each day
3. For each day:
   a. Cluster items by area (same city/region grouping)
   b. Within each cluster, apply nearest-neighbor shortest-path approximation
   c. Score each arrangement by total travel time
4. Return ranked list (top 3) with explainable reasons per suggestion
   - reason: "Groups Museum District items together, saves ~45 min travel"
```

### Bulk Import Flow

```
1. POST /import/upload {file, entityType, idempotencyKey}
2. Check idempotency key not already used
3. Parse file (Excel/CSV)
4. Pre-validate all rows (schema, required fields, types)
5. Deduplicate by configurable key (default: name + street_line + city)
6. Return validation report with row-level errors before committing
7. POST /import/:batchId/commit — commit valid rows
8. Store batch with rollback_until = now + 10 min
9. POST /import/:batchId/rollback — available within 10 min window
```

### Model Inference

```
1. POST /models/:id/infer {input, context}
2. Load active model (or canary based on A/B allocation)
3. Execute inference via adapter (PMML/ONNX/custom process)
4. Apply combined rule-and-model decisioning
5. Return result + explainability payload:
   {
     prediction: ...,
     confidence: 0.87,
     confidenceBand: [0.82, 0.92],
     topFeatures: [{feature: "...", contribution: 0.34}, ...],
     appliedRules: [{rule: "...", triggered: true}, ...]
   }
```

---

## 7. Security Design

- Passwords: bcrypt rounds=12, min 12 chars, complexity enforced, last 5 reuse blocked
- JWT: HS256, access token 30 min, refresh token 14 days, secret from env
- Field encryption: AES-256-GCM for security question answers, sensitive notes
- Audit log: append-only at the database layer (`audit_logs_no_update` and
  `audit_logs_no_delete` triggers raise `SQLSTATE 45000` on any UPDATE or
  DELETE attempt — see migration `20260409000000_audit_immutability`).
- Account lockout: 10 failed attempts in rolling 15 min → locked for 15 min
- Device limit: max 5 active devices per user
- Unusual location: challenge prompt if city differs from last known device city
- Idempotency keys: stored 24 hours, fingerprinted by (verified actor, method, route, body hash). Forged bearer tokens cannot replay another user's cached response.
- Sensitive fields masked in audit log exports (bcrypt hashes, encrypted answers, token hashes)
- Request IDs: UUID per request, canonical field name is `requestId`, exposed via `X-Request-Id` response header on every response (success and error). The legacy `traceId` body field and `X-Trace-Id` header are kept temporarily as backwards-compatible aliases.

### Secret quality requirements

The server's environment loader (`src/config/environment.ts`) refuses to start
if any of the following are missing or weak in non-test runtimes:

- `JWT_SECRET` — at least 32 characters; rejects known placeholder values.
- `ENCRYPTION_KEY` — exactly 32 characters; rejects known placeholder values.
- `DATABASE_URL` — required.

There are no hardcoded fallback secrets anywhere in the runtime. Test
runtimes (`NODE_ENV=test`) accept deterministic defaults so the unit/API
suites can run without per-shell setup; those defaults are clearly marked
as test-only constants and never reach production paths.

---

## 8. Background Jobs

| Job | Interval | Description |
|---|---|---|
| Notification outbox processor | 30s | Deliver pending notifications with exponential backoff |
| Notification retry | 1 min | Retry failed notifications (max 3 attempts) |
| Idempotency key cleanup | 1 hour | Delete expired idempotency keys |
| Refresh token cleanup | 1 hour | Delete expired/revoked refresh tokens |
| Import rollback expiry | 5 min | Mark import batches past rollback window |
| Daily notification cap reset | midnight | Reset daily message counts |

---

## 9. Error Handling

All non-2xx responses follow the canonical envelope:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "human readable message",
  "requestId": "11111111-2222-3333-4444-555555555555",
  "details": { "...": "optional structured context" }
}
```

Rules:

- `requestId` is the canonical correlation field. It always equals the
  `X-Request-Id` response header for the same request.
- A client may supply `X-Request-Id` (or the legacy `X-Trace-Id`) on the
  request; the server echoes that exact value back instead of generating a
  fresh one. This applies to both success and error responses.
- The body field `traceId` and the response header `X-Trace-Id` are kept as
  backwards-compatible aliases for existing clients. New integrations should
  use `requestId` only.

Standard codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN`
(403), `NOT_FOUND` (404), `CONFLICT` (409), `IDEMPOTENCY_CONFLICT` (409),
`RATE_LIMITED` (429), `DEVICE_LIMIT_REACHED` (409), `ACCOUNT_LOCKED` (423),
`INTERNAL_ERROR` (500).

Coverage of the envelope across status codes is asserted by
`API_tests/envelope.api.spec.ts`.

---

## 10. Deployment

TripForge has two officially supported deployment topologies:

### 10.1 Single-container (acceptance)

The acceptance artifact is one Docker image that bundles the API, a local
MariaDB instance, and the entrypoint that wires them together. This is what
the requirements call a "single Docker container deployable".

```bash
docker build -t tripforge .

docker run --rm -p 3000:3000 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ENCRYPTION_KEY=$(openssl rand -base64 24 | cut -c1-32) \
  -v tripforge_data:/var/lib/mysql \
  tripforge
```

`docker/entrypoint.sh` performs:

1. Validate `JWT_SECRET` (>=32 chars) and `ENCRYPTION_KEY` (exactly 32 chars). Refuse to start otherwise.
2. Initialise `/var/lib/mysql` on first boot. Auto-generate a strong local DB password (persisted in the data dir, never leaves the container).
3. Start `mariadbd` bound to `127.0.0.1`, wait until it accepts connections.
4. Bootstrap the application database/user.
5. Run `prisma migrate deploy` (which installs the audit immutability triggers).
6. `exec node dist/server.js`.

The API server's own environment loader runs the same secret-quality checks
again before opening port 3000, so misconfiguration cannot leak past the
entrypoint.

### 10.2 Compose (development)

Compose runs API and MySQL as separate services and is intended for local
development. It uses env interpolation with `?` defaults, so it refuses to
start if any required secret is missing — there are no hardcoded credentials
in `docker-compose.yml`.

```yaml
services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL must be set}
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET must be set to a strong random value (>=32 chars)}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?ENCRYPTION_KEY must be set to a 32-character random value}
      ACCESS_TOKEN_TTL: ${ACCESS_TOKEN_TTL:-1800}
      REFRESH_TOKEN_TTL: ${REFRESH_TOKEN_TTL:-1209600}
      PORT: ${PORT:-3000}
      NODE_ENV: ${NODE_ENV:-production}
    depends_on:
      db:
        condition: service_healthy
    command: sh -c "npx prisma migrate deploy && node dist/server.js"

  db:
    image: mysql:8
    environment:
      MYSQL_USER: ${MYSQL_USER:?MYSQL_USER must be set}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:?MYSQL_PASSWORD must be set to a strong value}
      MYSQL_DATABASE: ${MYSQL_DATABASE:-tripforge}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD must be set to a strong value}
    volumes:
      - mysqldata:/var/lib/mysql

volumes:
  mysqldata:
```

---

## 11. Performance Strategy

- Index all foreign keys
- Index `itinerary_items.itinerary_id`, `itinerary_items.day_number`
- Index `audit_logs.created_at`, `audit_logs.actor_id`
- Index `idempotency_keys.expires_at` for cleanup job
- Index `notifications.user_id`, `notifications.delivered`
- Index `import_batches.idempotency_key`
- Prisma query optimization for complex joins
- Connection pool: min 2, max 10
- Import batches processed in chunks of 500 rows

---

## 12. Implementation Readiness Rules (Must Follow)

1. Security-first ordering
- Implement authentication, route authorization, object-level authorization, and data isolation before non-critical modules.

2. No ambiguous behavior in code
- Use `docs/questions.md` as binding decisions for ambiguous prompt areas.
- If a new ambiguity appears, add Question + Assumption + Solution before implementing.

3. Test-before-expansion rule
- For each slice, add or update unit/integration tests in the same change set.
- Minimum requirement to close a slice: happy path + one high-risk exception path.

4. API-contract consistency
- Runtime responses must follow `docs/api-spec.md` status codes and payload shape.
- Update API spec and tests together if implementation-level changes are unavoidable.

5. Logging and data protection
- Never log tokens, raw passwords, or decrypted sensitive fields.
- All logs include request ID and category (`auth`, `rbac`, `itinerary`, `import`, `model`, `notification`).

6. Acceptance gate requirement
- Before marking final completion, pass every gate in `docs/acceptance-checklist.md` and update `docs/AI-self-test.md`.
