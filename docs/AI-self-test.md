
# TripForge — AI Self-Test Checklist

This document is used to verify all prompt requirements are implemented before submission.

Current baseline status:
- Project stage: planning/specification only
- Implementation status: blocked until foundation artifacts are created
- Primary gate tracker: `docs/acceptance-checklist.md`

---

## Authentication and Identity

- [ ] `POST /auth/register` — creates user with bcrypt password + 2 security questions (AES-256 encrypted answers)
- [ ] `POST /auth/login` — validates credentials, issues access token (30 min) + refresh token (14 days)
- [ ] `POST /auth/refresh` — issues new access token from valid refresh token
- [ ] `POST /auth/logout` — revokes refresh token
- [ ] `PATCH /auth/change-password` — enforces 12+ char complexity + last-5-reuse block
- [ ] `POST /auth/recover` — resets password via security question answers (no email/SMS)
- [ ] Device registration on login — max 5 active devices per user enforced
- [ ] Unusual-location detection — challenge prompt (429) when city differs from last known
- [ ] Account lockout — 10 failed attempts in 15 minutes → locked
- [ ] `GET /auth/devices` — list registered devices
- [ ] `DELETE /auth/devices/:id` — remove device (revokes its refresh token)

---

## RBAC and Authorization

- [ ] `GET/POST /roles` — role CRUD (Admin only)
- [ ] `POST /roles/:id/permissions` — assign permission points to role
- [ ] `GET/POST /permission-points` — permission point CRUD
- [ ] `GET/POST /menus` — menu (capability bundle) CRUD
- [ ] `POST /users/:id/roles` — assign roles to user
- [ ] RBAC middleware enforces permission points on all protected routes
- [ ] Data-scope: Organizer sees only own itineraries; Admin sees all
- [ ] All permission changes appear in audit log

---

## Itinerary Management

- [ ] `GET/POST /itineraries` — list (scoped) and create
- [ ] `GET/PATCH/DELETE /itineraries/:id` — get, update, delete
- [ ] `GET/POST /itineraries/:id/items` — list and add items
- [ ] `PATCH/DELETE /itineraries/:id/items/:itemId` — update and remove items
- [ ] Overlap detection → 409
- [ ] 15-minute buffer enforcement → 409
- [ ] Business hours enforcement → 400
- [ ] Closure date enforcement → 400
- [ ] Min dwell time enforcement → 400
- [ ] Travel time matrix enforcement → 409
- [ ] Every save creates a versioned revision with diff metadata
- [ ] `GET /itineraries/:id/versions` — version history

---

## Route Optimization

- [ ] `GET /itineraries/:id/optimize` — returns ranked suggestions (top 3)
- [ ] Same-area clustering by city/region
- [ ] Nearest-neighbor shortest-path approximation
- [ ] Explainability payload per suggestion (reason string, time saved estimate)

---

## Share and Export

- [ ] `POST /itineraries/:id/share` — generates share token (7-day TTL)
- [ ] `GET /shared/:token` — public access to shared itinerary
- [ ] Share token expiry enforced (404 after 7 days)
- [ ] `GET /itineraries/:id/export` — standardized itinerary package (JSON)

---

## Resource Management

- [ ] `GET/POST /resources` — list and create resources
- [ ] `GET/PATCH/DELETE /resources/:id` — get, update, delete
- [ ] `GET/POST /resources/:id/hours` — business hours CRUD
- [ ] `GET/POST /resources/:id/closures` — closure dates CRUD
- [ ] `GET/POST /travel-times` — travel time matrix CRUD

---

## Data Import/Export

- [ ] `GET /import/templates/:entityType` — download Excel/CSV template
- [ ] `POST /import/upload` — parse + pre-validate, return row-level errors
- [ ] Deduplication by configurable key (default: name + streetLine + city)
- [ ] `POST /import/:batchId/commit` — apply valid rows
- [ ] `POST /import/:batchId/rollback` — rollback within 10-minute window
- [ ] `GET /import/:batchId` — batch status and error report
- [ ] Idempotency key required on upload
- [ ] Handles 10,000 rows per batch

---

## Model Management and Inference

- [ ] `GET/POST /models` — model registry CRUD
- [ ] `PATCH /models/:id` — update activation status (inactive/active/canary)
- [ ] `POST /models/:id/ab-allocations` — A/B allocation configuration
- [ ] `POST /models/:id/infer` — local inference via adapter
- [ ] Combined rule-and-model decisioning
- [ ] Explainability payload: top features, confidence bands, applied rules

---

## Notification Center

- [ ] `GET /notifications` — list notifications for current user (read/unread filter)
- [ ] `PATCH /notifications/:id/read` — mark as read
- [ ] `GET /notifications/stats` — delivery stats (Admin)
- [ ] `GET/POST /notification-templates` — template CRUD
- [ ] `PATCH /notification-templates/:id` — update template
- [ ] Template variable resolution ({{variable}} placeholders)
- [ ] Retry up to 3 times with exponential backoff
- [ ] Per-user frequency cap (default 20/day)
- [ ] User blacklist flag
- [ ] Delivery receipts tracked

---

## Security

- [ ] bcrypt rounds=12 on all passwords
- [ ] AES-256-GCM on security question answers and sensitive fields
- [ ] Password policy: 12+ chars, upper+lower+digit+special, last-5 reuse blocked
- [ ] Sensitive fields masked in audit log exports ([REDACTED])
- [ ] Audit log INSERT-only (no DELETE for app DB role)
- [ ] Idempotency keys stored 24 hours
- [ ] X-Request-Id header on every response
- [ ] Structured JSON logging with sensitive field masking

---

## Infrastructure

- [ ] `docker compose up` starts cleanly (API + MySQL)
- [ ] Prisma migrations run on startup
- [ ] `GET /health` returns 200
- [ ] Swagger UI at `/api/docs`
- [ ] `run_tests.sh` passes all unit + integration tests
- [ ] README has startup command, ports, test credentials
- [ ] `.env.example` has all required vars
- [ ] No node_modules, dist, or compiled output in ZIP
- [ ] No real credentials in any config file
- [ ] `metadata.json` present with all required fields
- [ ] `sessions/develop-1.json` trajectory file present
- [ ] p95 latency target: all read queries have proper indexes documented
