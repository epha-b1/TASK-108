# Test Coverage Audit

## Project Type Detection
- Declared in `repo/README.md:3` as `backend`.
- Light repo inspection is consistent with backend-only: no frontend source tree or frontend test files detected (`repo/src/**/*.{tsx,jsx,vue,svelte,css,scss,html}` returned none).

## Backend Endpoint Inventory

Resolved from `repo/src/app.ts` and route modules under `repo/src/routes/*.ts`.

1. `GET /health`
2. `GET /__test__/boom` (test-only when `NODE_ENV=test`)
3. `GET /api/docs` (Swagger mount)
4. `GET /api/docs/*` (Swagger assets, e.g., init JS)
5. `POST /auth/register`
6. `POST /auth/login`
7. `POST /auth/refresh`
8. `POST /auth/recover`
9. `POST /auth/logout`
10. `PATCH /auth/change-password`
11. `GET /auth/me`
12. `GET /auth/devices`
13. `DELETE /auth/devices/:id`
14. `GET /users`
15. `GET /users/:id`
16. `PATCH /users/:id`
17. `DELETE /users/:id`
18. `POST /users/:id/roles`
19. `GET /roles`
20. `POST /roles`
21. `POST /roles/:id/permissions`
22. `GET /permission-points`
23. `POST /permission-points`
24. `GET /menus`
25. `POST /menus`
26. `GET /resources`
27. `POST /resources`
28. `GET /resources/:id`
29. `PATCH /resources/:id`
30. `DELETE /resources/:id`
31. `GET /resources/:id/hours`
32. `POST /resources/:id/hours`
33. `GET /resources/:id/closures`
34. `POST /resources/:id/closures`
35. `GET /travel-times`
36. `POST /travel-times`
37. `GET /itineraries`
38. `POST /itineraries`
39. `GET /itineraries/:id`
40. `PATCH /itineraries/:id`
41. `DELETE /itineraries/:id`
42. `GET /itineraries/:id/items`
43. `POST /itineraries/:id/items`
44. `PATCH /itineraries/:id/items/:itemId`
45. `DELETE /itineraries/:id/items/:itemId`
46. `GET /itineraries/:id/optimize`
47. `GET /itineraries/:id/versions`
48. `POST /itineraries/:id/share`
49. `GET /itineraries/:id/export`
50. `GET /shared/:token`
51. `GET /import/templates/:entityType`
52. `POST /import/upload`
53. `POST /import/:batchId/commit`
54. `POST /import/:batchId/rollback`
55. `GET /import/:batchId`
56. `GET /models`
57. `POST /models`
58. `GET /models/:id`
59. `PATCH /models/:id`
60. `POST /models/:id/ab-allocations`
61. `POST /models/:id/infer`
62. `GET /notifications`
63. `PATCH /notifications/:id/read`
64. `GET /notifications/stats`
65. `POST /notifications`
66. `GET /notification-templates`
67. `POST /notification-templates`
68. `PATCH /notification-templates/:id`
69. `GET /audit-logs`
70. `GET /audit-logs/export`

## API Test Mapping Table

All entries below are covered by HTTP-level tests via `supertest(request(app))` importing `repo/src/app.ts` directly (example evidence: `repo/API_tests/auth.api.spec.ts:1-4`).

| Endpoint | Covered | Test type | Test files | Evidence |
|---|---|---|---|---|
| `GET /health` | yes | true no-mock HTTP | `API_tests/health.api.spec.ts` | `describe('GET /health')` at `repo/API_tests/health.api.spec.ts:4` |
| `GET /__test__/boom` | yes | true no-mock HTTP | `API_tests/envelope.api.spec.ts` | `it('500 INTERNAL_ERROR — synthetic /__test__/boom'...)` at `repo/API_tests/envelope.api.spec.ts:276` |
| `GET /api/docs` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `describe('GET /api/docs — Swagger UI mount'...)` at `repo/API_tests/uncovered_endpoints.api.spec.ts:404` |
| `GET /api/docs/*` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `GET /api/docs/swagger-ui-init.js` at `repo/API_tests/uncovered_endpoints.api.spec.ts:431` |
| `POST /auth/register` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/register')` at `repo/API_tests/auth.api.spec.ts:39` |
| `POST /auth/login` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/login')` at `repo/API_tests/auth.api.spec.ts:74` |
| `POST /auth/refresh` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/refresh')` at `repo/API_tests/auth.api.spec.ts:166` |
| `POST /auth/recover` | yes | true no-mock HTTP | `API_tests/auth_recover.api.spec.ts` | `describe('POST /auth/recover — validation')` at `repo/API_tests/auth_recover.api.spec.ts:62` |
| `POST /auth/logout` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('POST /auth/logout')` at `repo/API_tests/auth.api.spec.ts:179` |
| `PATCH /auth/change-password` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('PATCH /auth/change-password')` at `repo/API_tests/auth.api.spec.ts:265` |
| `GET /auth/me` | yes | true no-mock HTTP | `API_tests/auth.api.spec.ts` | `describe('GET /auth/me')` at `repo/API_tests/auth.api.spec.ts:237` |
| `GET /auth/devices` | yes | true no-mock HTTP | `API_tests/device_and_challenge.api.spec.ts` | request at `repo/API_tests/device_and_challenge.api.spec.ts:125-127` |
| `DELETE /auth/devices/:id` | yes | true no-mock HTTP | `API_tests/device_and_challenge.api.spec.ts` | request at `repo/API_tests/device_and_challenge.api.spec.ts:142-145` |
| `GET /users` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /users (admin-only)')` at `repo/API_tests/rbac.api.spec.ts:171` |
| `GET /users/:id` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /users/:id')` at `repo/API_tests/rbac.api.spec.ts:194` |
| `PATCH /users/:id` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | `it('user.update lands in audit_logs...')` at `repo/API_tests/audit.api.spec.ts:207` |
| `DELETE /users/:id` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | `it('user.delete lands in audit_logs...')` at `repo/API_tests/audit.api.spec.ts:246` |
| `POST /users/:id/roles` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /users/:id/roles')` at `repo/API_tests/rbac.api.spec.ts:149` |
| `GET /roles` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /roles')` at `repo/API_tests/rbac.api.spec.ts:104` |
| `POST /roles` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /roles')` at `repo/API_tests/rbac.api.spec.ts:81` |
| `POST /roles/:id/permissions` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /roles/:id/permissions')` at `repo/API_tests/rbac.api.spec.ts:136` |
| `GET /permission-points` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `describe('GET /permission-points')` at `repo/API_tests/uncovered_endpoints.api.spec.ts:181` |
| `POST /permission-points` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /permission-points')` at `repo/API_tests/rbac.api.spec.ts:114` |
| `GET /menus` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('GET /menus')` at `repo/API_tests/rbac.api.spec.ts:211` |
| `POST /menus` | yes | true no-mock HTTP | `API_tests/rbac.api.spec.ts` | `describe('POST /menus')` at `repo/API_tests/rbac.api.spec.ts:221` |
| `GET /resources` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('GET /resources')` at `repo/API_tests/resources.api.spec.ts:115` |
| `POST /resources` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /resources')` at `repo/API_tests/resources.api.spec.ts:93` |
| `GET /resources/:id` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('GET /resources/:id')` at `repo/API_tests/resources.api.spec.ts:126` |
| `PATCH /resources/:id` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('PATCH /resources/:id')` at `repo/API_tests/resources.api.spec.ts:137` |
| `DELETE /resources/:id` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('DELETE /resources/:id')` at `repo/API_tests/resources.api.spec.ts:263` |
| `GET /resources/:id/hours` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('GET /resources/:id/hours')` at `repo/API_tests/resources.api.spec.ts:206` |
| `POST /resources/:id/hours` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /resources/:id/hours')` at `repo/API_tests/resources.api.spec.ts:190` |
| `GET /resources/:id/closures` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `describe('GET /resources/:id/closures')` at `repo/API_tests/uncovered_endpoints.api.spec.ts:218` |
| `POST /resources/:id/closures` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /resources/:id/closures')` at `repo/API_tests/resources.api.spec.ts:217` |
| `GET /travel-times` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `describe('GET /travel-times — authenticated list')` at `repo/API_tests/uncovered_endpoints.api.spec.ts:458` |
| `POST /travel-times` | yes | true no-mock HTTP | `API_tests/resources.api.spec.ts` | `describe('POST /travel-times')` at `repo/API_tests/resources.api.spec.ts:231` |
| `GET /itineraries` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries')` at `repo/API_tests/itineraries.api.spec.ts:140` |
| `POST /itineraries` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('POST /itineraries')` at `repo/API_tests/itineraries.api.spec.ts:127` |
| `GET /itineraries/:id` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | cross-user read check at `repo/API_tests/itineraries.api.spec.ts:431-435` |
| `PATCH /itineraries/:id` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | patch tests at `repo/API_tests/itineraries.api.spec.ts:246` and `:294` |
| `DELETE /itineraries/:id` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('DELETE /itineraries/:id')` at `repo/API_tests/itineraries.api.spec.ts:530` |
| `GET /itineraries/:id/items` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `describe('GET /itineraries/:id/items')` at `repo/API_tests/uncovered_endpoints.api.spec.ts:253` |
| `POST /itineraries/:id/items` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('POST /itineraries/:id/items')` at `repo/API_tests/itineraries.api.spec.ts:150` |
| `PATCH /itineraries/:id/items/:itemId` | yes | true no-mock HTTP | `API_tests/itinerary_invariants.api.spec.ts` | request at `repo/API_tests/itinerary_invariants.api.spec.ts:362` |
| `DELETE /itineraries/:id/items/:itemId` | yes | true no-mock HTTP | `API_tests/itinerary_invariants.api.spec.ts` | request at `repo/API_tests/itinerary_invariants.api.spec.ts:419` |
| `GET /itineraries/:id/optimize` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries/:id/optimize')` at `repo/API_tests/itineraries.api.spec.ts:374` |
| `GET /itineraries/:id/versions` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries/:id/versions')` at `repo/API_tests/itineraries.api.spec.ts:181` |
| `POST /itineraries/:id/share` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('POST /itineraries/:id/share')` at `repo/API_tests/itineraries.api.spec.ts:384` |
| `GET /itineraries/:id/export` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /itineraries/:id/export')` at `repo/API_tests/itineraries.api.spec.ts:404` |
| `GET /shared/:token` | yes | true no-mock HTTP | `API_tests/itineraries.api.spec.ts` | `describe('GET /shared/:token')` at `repo/API_tests/itineraries.api.spec.ts:396` |
| `GET /import/templates/:entityType` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('GET /import/templates/:entityType')` at `repo/API_tests/import.api.spec.ts:48` |
| `POST /import/upload` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('POST /import/upload')` at `repo/API_tests/import.api.spec.ts:101` |
| `POST /import/:batchId/commit` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('POST /import/:batchId/commit')` at `repo/API_tests/import.api.spec.ts:130` |
| `POST /import/:batchId/rollback` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('POST /import/:batchId/rollback')` at `repo/API_tests/import.api.spec.ts:141` |
| `GET /import/:batchId` | yes | true no-mock HTTP | `API_tests/import.api.spec.ts` | `describe('GET /import/:batchId')` at `repo/API_tests/import.api.spec.ts:196` |
| `GET /models` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('GET /models')` at `repo/API_tests/models.api.spec.ts:106` |
| `POST /models` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('POST /models')` at `repo/API_tests/models.api.spec.ts:76` |
| `GET /models/:id` | yes | true no-mock HTTP | `API_tests/models_decisioning.api.spec.ts` | unknown-id read at `repo/API_tests/models_decisioning.api.spec.ts:301-304` |
| `PATCH /models/:id` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('PATCH /models/:id')` at `repo/API_tests/models.api.spec.ts:117` |
| `POST /models/:id/ab-allocations` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('POST /models/:id/ab-allocations')` at `repo/API_tests/models.api.spec.ts:129` |
| `POST /models/:id/infer` | yes | true no-mock HTTP | `API_tests/models.api.spec.ts` | `describe('POST /models/:id/infer')` at `repo/API_tests/models.api.spec.ts:150` |
| `GET /notifications` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('GET /notifications')` at `repo/API_tests/notifications.api.spec.ts:149` |
| `PATCH /notifications/:id/read` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('PATCH /notifications/:id/read')` at `repo/API_tests/notifications.api.spec.ts:179` |
| `GET /notifications/stats` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('GET /notifications/stats')` at `repo/API_tests/notifications.api.spec.ts:190` |
| `POST /notifications` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('POST /notifications — send notification')` at `repo/API_tests/notifications.api.spec.ts:160` |
| `GET /notification-templates` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('GET /notification-templates')` at `repo/API_tests/notifications.api.spec.ts:138` |
| `POST /notification-templates` | yes | true no-mock HTTP | `API_tests/notifications.api.spec.ts` | `describe('POST /notification-templates')` at `repo/API_tests/notifications.api.spec.ts:120` |
| `PATCH /notification-templates/:id` | yes | true no-mock HTTP | `API_tests/uncovered_endpoints.api.spec.ts` | `describe('PATCH /notification-templates/:id')` at `repo/API_tests/uncovered_endpoints.api.spec.ts:331` |
| `GET /audit-logs` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | `describe('GET /audit-logs')` at `repo/API_tests/audit.api.spec.ts:69` |
| `GET /audit-logs/export` | yes | true no-mock HTTP | `API_tests/audit.api.spec.ts` | `describe('GET /audit-logs/export')` at `repo/API_tests/audit.api.spec.ts:91` |

## API Test Classification

### 1) True No-Mock HTTP
- Present across all files in `repo/API_tests/*.spec.ts`.
- Evidence: direct `supertest` + `app` import (`repo/API_tests/auth.api.spec.ts:1-4`, `repo/API_tests/rbac.api.spec.ts:1-4`, `repo/API_tests/import.api.spec.ts:1-4`) and real Prisma connectivity/cleanup (`beforeAll/afterAll` with `prisma.$connect/$disconnect`, e.g., `repo/API_tests/auth.api.spec.ts:22-37`).
- Count: 29/29 API test files.

### 2) HTTP with Mocking
- None found in `repo/API_tests` (no `jest.mock`, `vi.mock`, `sinon.stub` matches).

### 3) Non-HTTP (unit/integration without HTTP)
- Not applicable inside `repo/API_tests`; this category exists in `repo/unit_tests` only.

## Mock Detection (Strict)

### API suite
- No mock/stub usage detected in `repo/API_tests`.

### Non-API tests (informational, affects sufficiency interpretation)
- Prisma is mocked in unit project via Jest module mapping: `repo/jest.config.js:72-75` (`../models/prisma` -> `src/__mocks__/prisma.ts`).
- Route-level HTTP with mocking exists in `repo/unit_tests/import_routes.spec.ts:10` (`jest.mock('../src/middleware/auth.middleware', ...)`) while using supertest.
- Service/controller unit tests heavily rely on spies/mocks, e.g. `repo/unit_tests/controllers.spec.ts:64-66`, `repo/unit_tests/model_adapters.spec.ts:21`, `repo/unit_tests/model_adapters.spec.ts:42`.

## Coverage Summary
- Total endpoints inventoried: **70**
- Endpoints with HTTP tests: **70**
- Endpoints with true no-mock HTTP tests: **70**
- HTTP coverage: **100.0%**
- True API coverage: **100.0%**

## Unit Test Analysis

### Backend Unit Tests
- Test files: present extensively under `repo/unit_tests/*.spec.ts`.
- Controllers covered: broad handler coverage in `repo/unit_tests/controllers.spec.ts` and targeted users coverage in `repo/unit_tests/users_controller.spec.ts`.
- Services covered: `auth`, `model`, `itinerary`, `import`, `resource`, `notification`, `rbac`, `audit`, `routing`, `scheduler` (examples: `repo/unit_tests/auth_service_full.spec.ts`, `repo/unit_tests/model_service_full.spec.ts`, `repo/unit_tests/itinerary_service_full.spec.ts`, `repo/unit_tests/routing.spec.ts`).
- Middleware covered: `auth`, `validate`, `idempotency` (`repo/unit_tests/auth_middleware.spec.ts`, `repo/unit_tests/validate_middleware.spec.ts`, `repo/unit_tests/idempotency.spec.ts`).
- Repository layer: no dedicated repository abstraction appears in source layout (Prisma calls are service-level).

Important backend modules NOT directly unit-tested in isolation (dedicated file-level specs absent):
- `repo/src/config/swagger.ts`
- `repo/src/config/database.ts` (only indirectly hit)
- `repo/src/middleware/audit.middleware.ts` (primarily API-tested)
- `repo/src/routes/*.ts` except targeted import routes (`repo/unit_tests/import_routes.spec.ts`)

### Frontend Unit Tests
- Frontend test files: **NONE**
- Frameworks/tools detected for frontend testing: **NONE**
- Frontend components/modules covered: **NONE**
- Important frontend components/modules not tested: **N/A (no frontend code detected)**

Mandatory verdict:
- **Frontend unit tests: MISSING**

Interpretation in strict context:
- Project type is `backend` (not `fullstack`/`web`), so this is **not** a CRITICAL GAP under the provided frontend strict-failure rule.

### Cross-Layer Observation
- Backend-only codebase; frontend/backend balance analysis is not applicable.

## API Observability Check
- Strong overall: tests generally include explicit method/path, request payload/headers, and response assertions.
- Evidence examples:
  - Endpoint + input + output: `repo/API_tests/import.api.spec.ts:101-113`, `repo/API_tests/import.api.spec.ts:130-138`.
  - Error envelope shape and request correlation: `repo/API_tests/auth_recover.api.spec.ts:63-76`, `repo/API_tests/envelope.api.spec.ts:276-309`.
  - Auth/RBAC behavior visibility: `repo/API_tests/rbac.api.spec.ts:171-191`, `repo/API_tests/uncovered_endpoints.api.spec.ts:331-399`.
- Weak spots: a minority of assertions are status-only in some edge tests; not dominant.

## Test Quality & Sufficiency
- Success paths: broad coverage across auth, RBAC, resources, itineraries, import, models, notifications, audit.
- Failure paths: strong coverage (401/403/404/409/429/500 and validation envelopes).
- Edge cases: present (rate limits/challenge flow, lockout, idempotency, invariants, audit immutability).
- Validation depth: strong, especially import and schema validation branches.
- Auth/permissions: strong matrix testing via `repo/API_tests/permission_matrix.api.spec.ts` and `repo/API_tests/rbac_data_scope.api.spec.ts`.
- Integration boundaries: strong API-level execution with DB side effects and read-back assertions.

`run_tests.sh` check:
- Docker-based and containerized test execution confirmed (`repo/run_tests.sh:109`, `repo/run_tests.sh:154`, `repo/run_tests.sh:161`, `repo/run_tests.sh:178`).
- No host-side dependency install required in script flow.

## End-to-End Expectations
- Project type is backend; fullstack FE↔BE E2E expectation is not applicable.
- Backend API E2E behavior is heavily represented (`repo/API_tests/e2e_workflow.api.spec.ts`, `repo/API_tests/runtime_boundary_e2e.api.spec.ts`).

## Tests Check
- Endpoint inventory completeness: pass.
- HTTP mapping completeness: pass.
- Mocking contamination in API suite: none detected.
- Unit suite breadth: high, but mock-heavy by design.

## Test Coverage Score (0–100)
- **93/100**

## Score Rationale
- + Full endpoint-level HTTP coverage with no API-layer mocking.
- + Strong negative/edge-path testing and canonical envelope checks.
- + Dockerized deterministic test runner.
- - Unit tests are heavily mocked (expected, but limits realism at unit layer).
- - Some route/config modules rely mainly on indirect/API coverage, not focused unit specs.

## Key Gaps
- No dedicated isolated unit tests for certain config/middleware modules (`swagger`, `database`, `audit.middleware`).
- Some tests use status-dominant assertions instead of deeper payload/property invariants.

## Confidence & Assumptions
- Confidence: **high** for endpoint inventory and HTTP coverage mapping.
- Assumption: static route definitions in `repo/src/routes/*.ts` are authoritative and no runtime-generated routes add hidden endpoints.
- Assumption: conditional `GET /__test__/boom` is treated as endpoint because it exists in code for test runtime.

---

# README Audit

## README Location
- Found at required path: `repo/README.md`.

## Hard Gate Evaluation

### Formatting
- Pass: structured markdown with headings/tables/code fences (`repo/README.md`).

### Startup Instructions
- Pass for backend: includes required `docker-compose up` command (`repo/README.md:14`).

### Access Method
- Pass: URL + ports documented (`repo/README.md:25`, `repo/README.md:172-179`).

### Verification Method
- Pass: explicit health curl and test commands (`repo/README.md:58`, `repo/README.md:111-134`).

### Environment Rules (Docker-contained)
- Pass: README explicitly states Docker-contained dependencies and no host package-manager setup (`repo/README.md:17`, `repo/README.md:126-131`).
- No disallowed host install instructions (`npm install`, `pip install`, `apt-get`, manual DB setup) found.

### Demo Credentials (auth exists)
- Pass: credentials with roles provided (`repo/README.md:29-33`).

## Engineering Quality
- Tech stack clarity: strong (Express/Prisma/MariaDB/model adapters documented).
- Architecture and behavior depth: strong (error envelope, idempotency, versioning, immutability, model runtime constraints).
- Testing instructions: strong and Docker-first (`repo/README.md:124-145`, `repo/README.md:439-459`).
- Security/roles: clear and explicit (secret requirements, auth rules, role examples).

## High Priority Issues
- None.

## Medium Priority Issues
- Credential documentation is duplicated (`repo/README.md:29-33` and `repo/README.md:181-187`); second table omits explicit role column, which can create drift/confusion.

## Low Priority Issues
- README is long and partly repetitive; some sections can be consolidated for maintainability.

## Hard Gate Failures
- None.

## README Verdict
- **PASS**

---

## Final Verdicts
- Test Coverage Audit: **PASS (strong)**
- README Audit: **PASS**
