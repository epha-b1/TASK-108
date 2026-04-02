# TripForge — Feature Build Order

Build one slice at a time. Each slice must be fully working (implementation + tests) before moving to the next.

Use `docs/acceptance-checklist.md` as the gate tracker. Do not start a new slice until the current slice exit conditions are met.

## Required implementation sequence (strict)

1. Slice 1 (Foundation)
2. Slice 2 (Authentication and Identity)
3. Slice 3 (RBAC and Authorization)
4. Slice 4 (Resource Management)
5. Slice 5 (Itinerary Management)
6. Slice 6 (Route Optimization)
7. Slice 7 (Share and Export)
8. Slice 8 (Data Import/Export)
9. Slice 9 (Model Management and Inference)
10. Slice 10 (Notification Center)
11. Slice 11 (Security Hardening and Audit Log)
12. Slice 12 (Final Polish)
13. Slice 13 (Delivery Acceptance Gate)

---

## Slice 1 — Project Foundation
Done when:
- Express app boots with Prisma connected to MySQL
- `docker compose up` starts cleanly
- Prisma migrations run on startup
- Structured logging with request IDs on every request
- Health endpoint `GET /health` returns 200
- `.env.example` has all required vars
- `run_tests.sh` runs unit + integration tests

Must pass before continuing:
- A local developer can run the project from README commands without editing code.
- At least one unit test and one integration test execute end-to-end (even if minimal bootstrap tests).

---

## Slice 2 — Authentication and Identity
Done when:
- `POST /auth/register` creates user with bcrypt password, stores security questions (AES-256 encrypted answers)
- `POST /auth/login` validates credentials, issues access token (30 min) + refresh token (14 days)
- `POST /auth/refresh` issues new access token from valid refresh token
- `POST /auth/logout` revokes refresh token
- `PATCH /auth/change-password` enforces last-5-reuse policy and complexity rules
- `POST /auth/recover` resets password via security question answers
- Device registration on login (max 5 active devices per user)
- Unusual-location detection: compare lastKnownCity to device.last_known_city → rate-limited challenge
- Account lockout after 10 failed attempts in 15 minutes
- Audit log on login, logout, password change, device events
- Unit tests: bcrypt, JWT, lockout, device limit, location detection
- Integration tests: login, wrong password, lockout, refresh, logout, recovery

---

## Slice 3 — RBAC and Authorization
Done when:
- Role CRUD (Admin only)
- Permission point CRUD (Admin only)
- Menu CRUD (logical capability bundles)
- Role-to-permission-point assignment
- User-to-role assignment
- RBAC middleware enforces permission points on all protected routes
- Data-scope rules: Organizer sees only own itineraries; Admin sees all
- Full audit trail on all permission changes
- Integration tests: role assignment, permission enforcement, cross-user 403

---

## Slice 4 — Resource Management
Done when:
- Resource CRUD (attraction, lodging, meal, meeting)
- Business hours CRUD per resource (day-of-week, open/close time)
- Closure dates CRUD per resource
- Travel time matrix CRUD (from/to resource, minutes, transport mode)
- Integration tests: CRUD, hours, closures, travel times

---

## Slice 5 — Itinerary Management
Done when:
- Itinerary CRUD (title, destination, dates, status)
- Add/update/remove items into day-based time slots
- Conflict validation:
  - Overlap detection (409)
  - 15-minute buffer enforcement (409)
  - Business hours check (400)
  - Closure date check (400)
  - Min dwell time check (400)
  - Travel time matrix check (409)
- Versioned revision on every save (snapshot + diff metadata)
- Version history endpoint
- Data-scope: Organizer sees only own itineraries
- Unit tests: overlap detection, buffer check, dwell time, travel time
- Integration tests: add item, conflict scenarios, version history

---

## Slice 6 — Route Optimization
Done when:
- `GET /itineraries/:id/optimize` returns ranked suggestions (top 3)
- Same-area clustering by city/region
- Nearest-neighbor shortest-path approximation
- Explainability payload per suggestion (reason string, estimated time saved)
- Unit tests: clustering algorithm, nearest-neighbor, ranking
- Integration tests: optimize endpoint with various item configurations

---

## Slice 7 — Share and Export
Done when:
- `POST /itineraries/:id/share` generates share token (valid 7 days)
- `GET /shared/:token` returns itinerary without auth (public endpoint)
- `GET /itineraries/:id/export` returns standardized itinerary package (JSON)
- Share token expiry enforced
- Integration tests: share token generation, expiry, public access

---

## Slice 8 — Data Import/Export
Done when:
- `GET /import/templates/:entityType` returns Excel/CSV template
- `POST /import/upload` parses file, runs pre-validation, returns row-level errors
- Deduplication by configurable key (default: name + streetLine + city)
- `POST /import/:batchId/commit` applies valid rows
- `POST /import/:batchId/rollback` reverts within 10-minute window
- `GET /import/:batchId` returns batch status and error report
- Idempotency key on upload
- Throughput: handles 10,000 rows per batch (chunked processing)
- Unit tests: validation logic, deduplication, rollback window
- Integration tests: upload, commit, rollback, expired rollback 409

---

## Slice 9 — Model Management and Inference
Done when:
- Model registry CRUD (name, semver, type: pmml/onnx/custom)
- Activation status management (inactive, active, canary)
- A/B allocation configuration
- `POST /models/:id/infer` executes model locally via adapter
- Combined rule-and-model decisioning
- Explainability payload: top features, confidence bands, applied rules
- Integration tests: register, activate, infer, A/B allocation

---

## Slice 10 — Notification Center
Done when:
- Notification template CRUD with {{variable}} placeholder support
- Send notification to user (resolves template variables)
- In-app notification list per user (read/unread filter)
- Mark notification as read
- Outbox pattern: retry up to 3 times with exponential backoff
- Per-user frequency cap (default 20/day), blacklist flag
- Delivery receipts and reach stats endpoint
- Background job: outbox processor (every 30s)
- Unit tests: template variable resolution, retry backoff, frequency cap
- Integration tests: send, read, retry, cap enforcement

---

## Slice 11 — Security Hardening and Audit Log
Done when:
- AES-256-GCM encryption verified on all sensitive fields
- Strict password policy enforced (12+ chars, complexity, last-5 reuse)
- Masking in audit log exports (password_hash, encrypted fields → [REDACTED])
- Append-only audit_logs (no DELETE for app DB role)
- Idempotency keys on all mutating operations (stored 24h)
- Audit log query endpoint (Admin only)
- Audit log CSV export with masking
- Integration tests: audit log read, masking in export, 403 for non-admin

---

## Slice 12 — Final Polish
Done when:
- `run_tests.sh` passes all unit + integration tests
- `docker compose up` cold start works
- README has startup command, service addresses, test credentials
- No node_modules, dist, or compiled output in repo
- No real credentials in any config file
- Swagger UI available at `/api/docs`
- All p95 read queries have proper indexes
- Import throughput verified at 10,000 rows

---

## Slice 13 — Delivery Acceptance Gate (Final Test)

Done when:
- Item-by-item acceptance review is written with evidence (`path:line`) for every major criterion (runnable, completeness, architecture, engineering quality, prompt fitness, test coverage)
- Security-first review is explicit for authentication, route-level authorization, object-level authorization, and user data isolation
- Static test coverage audit maps prompt requirement points to unit/integration test cases and marks each as sufficient/basic/insufficient/missing
- Environment restriction notes are separated from product defects (e.g., sandbox/docker permission limits)
- Findings are prioritized by severity: Blocking, High, Medium, Low
- Report includes reproducible verification commands and expected results for each section
- Final acceptance report is stored under `./.tmp/*.md`
