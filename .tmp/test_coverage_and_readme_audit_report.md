# Test Coverage Audit

## Scope, Method, and Project Type
- Audit mode: static inspection only (no commands/tests/builds executed).
- Project type declaration at README top is **missing** (`repo/README.md:1-4`).
- Inferred project type: **backend** (Express API-only structure in `repo/src/app.ts:20-56`, no frontend source files found; only `repo/templates/.gitkeep`).

## Backend Endpoint Inventory
Resolved from `repo/src/app.ts` + `repo/src/routes/*.ts`.

1. `GET /health`
2. `GET /__test__/boom` (test-only branch)
3. `POST /auth/register`
4. `POST /auth/login`
5. `POST /auth/refresh`
6. `POST /auth/recover`
7. `POST /auth/logout`
8. `PATCH /auth/change-password`
9. `GET /auth/me`
10. `GET /auth/devices`
11. `DELETE /auth/devices/:id`
12. `GET /users`
13. `GET /users/:id`
14. `PATCH /users/:id`
15. `DELETE /users/:id`
16. `POST /users/:id/roles`
17. `GET /roles`
18. `POST /roles`
19. `POST /roles/:id/permissions`
20. `GET /permission-points`
21. `POST /permission-points`
22. `GET /menus`
23. `POST /menus`
24. `GET /resources`
25. `POST /resources`
26. `GET /resources/:id`
27. `PATCH /resources/:id`
28. `DELETE /resources/:id`
29. `GET /resources/:id/hours`
30. `POST /resources/:id/hours`
31. `GET /resources/:id/closures`
32. `POST /resources/:id/closures`
33. `GET /travel-times`
34. `POST /travel-times`
35. `GET /itineraries`
36. `POST /itineraries`
37. `GET /itineraries/:id`
38. `PATCH /itineraries/:id`
39. `DELETE /itineraries/:id`
40. `GET /itineraries/:id/items`
41. `POST /itineraries/:id/items`
42. `PATCH /itineraries/:id/items/:itemId`
43. `DELETE /itineraries/:id/items/:itemId`
44. `GET /itineraries/:id/optimize`
45. `GET /itineraries/:id/versions`
46. `POST /itineraries/:id/share`
47. `GET /itineraries/:id/export`
48. `GET /shared/:token`
49. `GET /import/templates/:entityType`
50. `POST /import/upload`
51. `POST /import/:batchId/commit`
52. `POST /import/:batchId/rollback`
53. `GET /import/:batchId`
54. `GET /models`
55. `POST /models`
56. `GET /models/:id`
57. `PATCH /models/:id`
58. `POST /models/:id/ab-allocations`
59. `POST /models/:id/infer`
60. `GET /notifications`
61. `PATCH /notifications/:id/read`
62. `GET /notifications/stats`
63. `POST /notifications`
64. `GET /notification-templates`
65. `POST /notification-templates`
66. `PATCH /notification-templates/:id`
67. `GET /audit-logs`
68. `GET /audit-logs/export`

## API Test Mapping Table

| Endpoint | Covered | Test Type | Test files | Evidence |
|---|---|---|---|---|
| `GET /health` | yes | true no-mock HTTP | `API_tests/health.api.spec.ts` | `describe('Health endpoint')`, request in file lines 5-21 |
| `GET /__test__/boom` | yes | true no-mock HTTP | `API_tests/envelope.api.spec.ts` | line 277 `.get('/__test__/boom')` |
| `POST /auth/register` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/register')` line 39 |
| `POST /auth/login` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/login')` line 74 |
| `POST /auth/refresh` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/refresh')` line 128 |
| `POST /auth/recover` | yes | true no-mock HTTP | `API_tests/auth_recover.api.spec.ts` | `describe('POST /auth/recover ...')` lines 62, 143, 200 |
| `POST /auth/logout` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/logout')` line 141 |
| `PATCH /auth/change-password` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('PATCH /auth/change-password')` line 227 |
| `GET /auth/me` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('GET /auth/me')` line 199 |
| `GET /auth/devices` | yes | true no-mock HTTP | `API_tests/device_and_challenge.api.spec.ts` | line 126 `.get('/auth/devices')` |
| `DELETE /auth/devices/:id` | yes | true no-mock HTTP | `API_tests/device_and_challenge.api.spec.ts` | line 143 `.delete(`/auth/devices/${removeId}`)` |
| `GET /users` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /users (admin-only)')` line 171 |
| `GET /users/:id` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /users/:id')` line 194 |
| `PATCH /users/:id` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | line 222 `.patch(`/users/${uid}`)` |
| `DELETE /users/:id` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | line 258 `.delete(`/users/${uid}`)` |
| `POST /users/:id/roles` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /users/:id/roles')` line 149 |
| `GET /roles` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /roles')` line 104 |
| `POST /roles` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /roles')` line 81 |
| `POST /roles/:id/permissions` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /roles/:id/permissions')` line 136 |
| `GET /permission-points` | **no** | unit-only / indirect | none found in API tests | route exists at `src/routes/rbac.routes.ts:22`; no `.get('/permission-points')` in `API_tests/*.ts` |
| `POST /permission-points` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /permission-points')` line 114 |
| `GET /menus` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /menus')` line 211 |
| `POST /menus` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /menus')` line 221 |
| `GET /resources` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('GET /resources')` line 115 |
| `POST /resources` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /resources')` line 93 |
| `GET /resources/:id` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('GET /resources/:id')` line 126 |
| `PATCH /resources/:id` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('PATCH /resources/:id')` line 137 |
| `DELETE /resources/:id` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('DELETE /resources/:id')` line 263 |
| `GET /resources/:id/hours` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('GET /resources/:id/hours')` line 206 |
| `POST /resources/:id/hours` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /resources/:id/hours')` line 190 |
| `GET /resources/:id/closures` | **no** | unit-only / indirect | none found in API tests | route exists at `src/routes/resources.routes.ts:38`; only POST closures tested |
| `POST /resources/:id/closures` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /resources/:id/closures')` line 217 |
| `GET /travel-times` | **no** | unit-only / indirect | none found in API tests | route exists at `src/routes/resources.routes.ts:45`; only POST travel-times tested |
| `POST /travel-times` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /travel-times')` line 231 |
| `GET /itineraries` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries')` line 140 |
| `POST /itineraries` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('POST /itineraries')` line 127 |
| `GET /itineraries/:id` | yes | true no-mock HTTP | `API_tests/e2e_workflow.api.spec.ts` | step 7, lines 199-203 |
| `PATCH /itineraries/:id` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | lines 254/295/332 |
| `DELETE /itineraries/:id` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('DELETE /itineraries/:id')` line 530 |
| `GET /itineraries/:id/items` | **no** | unit-only / indirect | none found in API tests | route exists at `src/routes/itineraries.routes.ts:39`; no `.get(.../items)` requests |
| `POST /itineraries/:id/items` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('POST /itineraries/:id/items')` line 150 |
| `PATCH /itineraries/:id/items/:itemId` | yes | true no-mock HTTP | `API_tests/itinerary_invariants.api.spec.ts` | line 362 patch item |
| `DELETE /itineraries/:id/items/:itemId` | yes | true no-mock HTTP | `API_tests/itinerary_invariants.api.spec.ts` | line 419 delete item |
| `GET /itineraries/:id/optimize` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries/:id/optimize')` line 374 |
| `GET /itineraries/:id/versions` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries/:id/versions')` line 181 |
| `POST /itineraries/:id/share` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('POST /itineraries/:id/share')` line 384 |
| `GET /itineraries/:id/export` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries/:id/export')` line 404 |
| `GET /shared/:token` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /shared/:token')` line 396 |
| `GET /import/templates/:entityType` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('GET /import/templates/:entityType')` line 48 |
| `POST /import/upload` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('POST /import/upload')` line 101 |
| `POST /import/:batchId/commit` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('POST /import/:batchId/commit')` line 130 |
| `POST /import/:batchId/rollback` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('POST /import/:batchId/rollback')` line 141 |
| `GET /import/:batchId` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('GET /import/:batchId')` line 196 |
| `GET /models` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('GET /models')` line 106 |
| `POST /models` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('POST /models')` line 76 |
| `GET /models/:id` | yes | true no-mock HTTP | `API_tests/models_decisioning.api.spec.ts` | lines 301-304 (unknown ID path) |
| `PATCH /models/:id` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('PATCH /models/:id')` line 117 |
| `POST /models/:id/ab-allocations` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('POST /models/:id/ab-allocations')` line 129 |
| `POST /models/:id/infer` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('POST /models/:id/infer')` line 150 |
| `GET /notifications` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('GET /notifications')` line 149 |
| `PATCH /notifications/:id/read` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('PATCH /notifications/:id/read')` line 179 |
| `GET /notifications/stats` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('GET /notifications/stats')` line 190 |
| `POST /notifications` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('POST /notifications — send notification')` line 160 |
| `GET /notification-templates` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('GET /notification-templates')` line 138 |
| `POST /notification-templates` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('POST /notification-templates')` line 120 |
| `PATCH /notification-templates/:id` | **no** | unit-only / indirect | none found in API tests | route exists at `src/routes/notifications.routes.ts:32`; no patch request in `API_tests/*.ts` |
| `GET /audit-logs` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | `describe('GET /audit-logs')` line 69 |
| `GET /audit-logs/export` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | `describe('GET /audit-logs/export')` line 91 |

## API Test Classification

### 1) True No-Mock HTTP
- All suites under `repo/API_tests/*.spec.ts` use `supertest` + `app` with real route stack and no `jest.mock/vi.mock/sinon.stub` in API test files.
- Representative evidence: `API_tests/auth.api.spec.ts:1-4`, `API_tests/resources.api.spec.ts:1-4`, `API_tests/e2e_workflow.api.spec.ts:17-20`.

### 2) HTTP with Mocking
- `repo/unit_tests/import_routes.spec.ts`: mocks auth middleware (`jest.mock('../src/middleware/auth.middleware', ...)` at line 10) and runs HTTP requests against mounted router.
- `repo/unit_tests/targeted_branches.spec.ts`: `jest.doMock(...)` for auth/schema modules (lines 192-201) then HTTP requests to import routes (lines 211-214).
- Unit project also remaps Prisma to mocks globally (`repo/jest.config.js:73-75`), so unit-suite HTTP calls are not true no-mock API tests.

### 3) Non-HTTP (unit/integration without HTTP)
- Most unit files (e.g., `unit_tests/auth_service_full.spec.ts`, `unit_tests/resource_service.spec.ts`, `unit_tests/rbac_service.spec.ts`, `unit_tests/model_service_full.spec.ts`) directly test services/controllers/middleware in-process with spies/mocks.

## Mock Detection (Required)
- `jest.mock('child_process'...)` in `repo/unit_tests/model_adapters.spec.ts:21`.
- `jest.mock('fs'...)` in `repo/unit_tests/model_adapters.spec.ts:42`.
- `jest.mock('../src/middleware/auth.middleware'...)` in `repo/unit_tests/import_routes.spec.ts:10`.
- `jest.mock('node-cron'...)` in `repo/unit_tests/scheduler.spec.ts:15`.
- `jest.mock('../src/services/notification.service'...)` in `repo/unit_tests/scheduler.spec.ts:25`.
- Dependency remapping to Prisma mocks in Jest config: `repo/jest.config.js:73-75`.

## Coverage Summary
- Total endpoints: **68**
- Endpoints with HTTP tests (any): **63**
- Endpoints with true no-mock HTTP tests: **63**
- HTTP coverage: **92.65%** (`63/68`)
- True API coverage: **92.65%** (`63/68`)

Uncovered endpoints (5):
- `GET /permission-points`
- `GET /resources/:id/closures`
- `GET /travel-times`
- `GET /itineraries/:id/items`
- `PATCH /notification-templates/:id`

## Unit Test Summary

### Backend Unit Tests
- Unit test files present: **37** under `repo/unit_tests/`.
- Controllers covered: broad controller delegation and branch coverage in `unit_tests/controllers.spec.ts` and `unit_tests/users_controller.spec.ts`.
- Services covered: auth/import/itinerary/model/notification/rbac/resource/routing/scheduler/audit via `*_service*.spec.ts` files.
- Middleware covered: auth/idempotency/validate in `unit_tests/auth_middleware.spec.ts`, `unit_tests/idempotency.spec.ts`, `unit_tests/validate_middleware.spec.ts`.
- Repositories: no explicit repository layer in `src/`; data access is Prisma in services/controllers.

Important backend modules not sufficiently unit-tested (from static evidence):
- Direct dedicated unit test for `src/routes/notifications.routes.ts` path `PATCH /notification-templates/:id` is absent; coverage relies on higher-level API tests, which are also missing this endpoint.
- Explicit isolated test for `src/routes/rbac.routes.ts` `GET /permission-points` is absent.
- Explicit isolated test for `src/routes/resources.routes.ts` `GET /travel-times` and `GET /resources/:id/closures` is absent.
- Explicit isolated test for `src/routes/itineraries.routes.ts` `GET /itineraries/:id/items` is absent.

### Frontend Unit Tests
- Frontend test files: **NONE**
- Frameworks/tools detected for frontend tests: **NONE**
- Frontend components/modules covered: **NONE**
- Important frontend components/modules not tested: **N/A (no frontend layer detected in repo)**
- **Frontend unit tests: MISSING**

Strict failure rule applicability:
- Project inferred as **backend**, not `fullstack`/`web`; therefore frontend-missing is **not** flagged as a CRITICAL GAP under the provided strict rule.

### Cross-Layer Observation
- No frontend codebase detected; balance analysis across FE/BE is not applicable.

## API Observability Check
- Strong/clear in most API suites: method/path explicit in describe blocks, request input shown via `.send/.field/.query`, and response assertions check status + body structure/codes (`API_tests/auth_recover.api.spec.ts`, `API_tests/import.api.spec.ts`, `API_tests/models_decisioning.api.spec.ts`).
- Weak spots: some checks assert mainly status/latency without deep response payload verification (`API_tests/performance.api.spec.ts`, parts of `API_tests/production_boot.api.spec.ts`).

## Tests Check
- Success paths: strong coverage across auth/resources/itineraries/import/models/notifications/audit.
- Failure/edge coverage: strong (validation errors, auth failures, lockout/rate-limit, idempotency conflicts, rollback windows, model runtime paths).
- Auth/permissions: strong route-level negative matrix (`API_tests/permission_matrix.api.spec.ts`).
- Integration boundaries: good API-layer coverage; true end-to-end through real HTTP + DB in API suite.
- `run_tests.sh` check: Docker-based orchestration (`docker compose ...`) and in-container Jest runs; no host package-manager dependency required for test execution path.

## End-to-End Expectations
- For inferred **backend** project: E2E-style backend journey is present (`API_tests/e2e_workflow.api.spec.ts`).
- Fullstack FE↔BE E2E expectation is not applicable because no frontend layer was detected.

## Test Coverage Score (0–100)
**84/100**

## Score Rationale
- High score drivers: large real HTTP suite with broad success/failure/edge/security coverage, strong negative auth/RBAC cases, strong envelope/assertion quality in many files.
- Deductions: 5 production endpoints lack direct HTTP coverage; a few observability/perf tests are shallow; unit-suite HTTP tests include mocks (acceptable for unit scope, but not true API coverage).

## Key Gaps
1. Missing direct tests for 5 endpoints (listed above) reduce deterministic route coverage.
2. No route-level API test for `PATCH /notification-templates/:id` despite sensitive admin behavior.
3. Some tests emphasize status over full payload/contract assertions.

## Confidence & Assumptions
- Confidence: **High** for endpoint inventory and coverage mapping (routes statically enumerated from `src/app.ts` + `src/routes/*.ts`).
- Assumption: third-party `swagger-ui-express` internal methods under `/api/docs` are excluded because methods are not explicitly declared in project route code.

---

# README Audit

## README Location Check
- `repo/README.md` exists.

## Hard Gate Results

### Formatting
- PASS: markdown structure is readable and organized (`repo/README.md` headings/tables/code blocks throughout).

### Startup Instructions (Backend/Fullstack requirement)
- **FAIL (strict)**: required literal `docker-compose up` is missing.
- Found: `docker compose up -d --build` (`repo/README.md:48`, `repo/README.md:111`), plus single-container `docker build`/`docker run` path.

### Access Method
- PASS: URLs/ports are provided (`repo/README.md:143-151`).

### Verification Method
- PASS: verification via `curl /health` and smoke commands is provided (`repo/README.md:82-93`).

### Environment Rules (Docker-contained only; no runtime installs)
- **FAIL**: README explicitly instructs runtime package install: `pip install onnxruntime` (`repo/README.md:296`).

### Demo Credentials (auth exists)
- Auth clearly exists (`/auth/*` routes in `src/routes/auth.routes.ts`).
- README provides usernames/passwords (`repo/README.md:152-158`) but does not explicitly map credentials to **all roles** in a role-complete matrix.
- **FAIL (strict interpretation of “ALL roles”)**.

## Engineering Quality
- Tech stack clarity: good (Express/Prisma/MySQL/Docker/test commands are documented).
- Architecture/behavior explanation: strong and detailed (error envelope, idempotency, versioning, model modes, logging categories).
- Testing instructions: strong (`run_tests.sh`, compose-based commands).
- Security/roles/workflows: well-documented but overloaded; document is long and mixes operator/runtime details with acceptance quick start.

## High Priority Issues
1. Missing required top-level project type declaration (`backend/fullstack/web/android/ios/desktop`) at README start.
2. Missing strict-required `docker-compose up` command string for backend/fullstack startup gate.
3. Runtime install command (`pip install onnxruntime`) violates strict Docker-contained environment rule.
4. Demo credentials section does not explicitly enumerate credentials per all roles.

## Medium Priority Issues
1. README is very long and blends operational hardening details with quick-start flow, reducing auditability for first-time reviewers.
2. Multiple startup modes (single-container vs compose) are not summarized with clear "acceptance path vs optional path" gate table.

## Low Priority Issues
1. Some sections are highly detailed but repetitive (security caveats and migration notes repeated across sections).

## Hard Gate Failures
1. Startup instructions gate (missing required `docker-compose up` literal).
2. Environment rules gate (runtime `pip install` instruction present).
3. Demo credentials gate (strict all-roles requirement not explicitly met).

## README Verdict
**FAIL**

## Final Verdicts
- Test Coverage Audit Verdict: **PARTIAL PASS** (strong overall, but 5 uncovered endpoints).
- README Audit Verdict: **FAIL** (hard-gate violations).
