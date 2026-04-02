# TripForge - Pre-Implementation Acceptance Checklist

Use this as the single source of truth before and during implementation.

Status legend:
- [ ] Not started
- [~] In progress
- [x] Complete
- [!] Blocked

Current project status baseline (from static acceptance audit):
- [!] Runnable backend skeleton missing
- [!] Core security implementation missing (authz/ownership/isolation)
- [!] Unit/integration tests missing

---

## A) Foundation Gate (must pass first)

- [ ] `repo/package.json` exists with scripts: `dev`, `build`, `test`, `test:unit`, `test:integration`
- [ ] `repo/README.md` exists with exact startup/test commands
- [ ] `repo/src/app.ts` and `repo/src/server.ts` boot Express successfully
- [ ] `repo/prisma/schema.prisma` exists and migrations run
- [ ] `repo/.env.example` exists with required variables
- [ ] `repo/run_tests.sh` executes unit + integration suites
- [ ] Request ID middleware is implemented and returns `X-Request-Id`
- [ ] Health endpoint `GET /health` returns 200

Exit condition:
- [ ] Project can be started and tested locally without editing core code.

---

## B) Security Gate (highest priority)

- [ ] Authentication endpoints implemented (`/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password`, `/auth/recover`)
- [ ] Route-level authorization middleware enforced on all protected routes
- [ ] Object-level authorization for itinerary ownership is enforced
- [ ] Data isolation checks implemented for organizer vs admin scope
- [ ] Account lockout implemented (10 failures in 15 minutes)
- [ ] Device cap enforced (max 5 active devices)
- [ ] Unusual location challenge flow implemented and rate-limited
- [ ] Sensitive fields masked in logs and audit exports
- [ ] Idempotency key support implemented for mutating operations

Exit condition:
- [ ] No known privilege escalation path in auth/authz/ownership/isolation checks.

---

## C) Core Business Gate

- [ ] Itinerary CRUD and item scheduling implemented
- [ ] Conflict validation implemented (overlap, 15-min buffer, business hours, closures, dwell, travel time)
- [ ] Versioning on content save with diff metadata
- [ ] Route optimization implemented (cluster + nearest-neighbor + top 3 explainable suggestions)
- [ ] Share token flow implemented (7-day TTL)
- [ ] Itinerary export implemented with standardized JSON package
- [ ] Resource CRUD + hours + closures + travel time matrix implemented
- [ ] Import flow implemented (template, upload, pre-validation, commit, rollback window)
- [ ] Model registry/inference implemented with local adapter and explainability payload
- [ ] Notification center implemented (templates, send/list/read, retry/backoff, cap, blacklist, stats)

Exit condition:
- [ ] All prompt core business functions are functionally reachable via API.

---

## D) Engineering Quality Gate

- [ ] Unified error format implemented (`statusCode`, `code`, `message`, `requestId`)
- [ ] Input validation in all write endpoints
- [ ] Structured logging enabled with category separation and masking
- [ ] Audit logs are append-only and queryable (admin only)
- [ ] Background jobs persist state for import/notification retry workflows
- [ ] Performance-sensitive DB indexes added and documented

Exit condition:
- [ ] Service behavior is diagnosable, maintainable, and operationally observable.

---

## E) Test Coverage Gate (mandatory)

- [ ] Unit tests exist for core services (auth, validation, routing, import, model, notification)
- [ ] Integration tests exist for major API modules
- [ ] Security tests exist for 401, 403, ownership violations, and data isolation
- [ ] Exception path tests exist (400, 404, 409, 429, idempotency conflicts)
- [ ] Boundary tests exist (pagination, empty datasets, time boundaries, rollback window)
- [ ] Sensitive-info leakage tests exist for logs/responses/exports
- [ ] README documents exact commands to run all tests

Exit condition:
- [ ] Tests are sufficient to catch the vast majority of critical defects.

---

## F) Submission Gate

- [ ] `docs/design.md`, `docs/features.md`, `docs/api-spec.md`, `docs/questions.md` remain aligned with implementation
- [ ] `docs/AI-self-test.md` updated to completed state where applicable
- [ ] `sessions/develop-1.json` exists
- [ ] `metadata.json` exists with required fields
- [ ] No real credentials committed
- [ ] No unnecessary artifacts in final package (`node_modules`, compiled outputs, temp exports/uploads)

Exit condition:
- [ ] Delivery package is review-ready and reproducible.
