# TripForge — Feature Overview

Offline-first backend API platform for travel itinerary planning, data ingestion, and model-assisted recommendations. Built with Express (TypeScript) + Prisma + MySQL. No UI. Pure backend.

Implementation priority policy:
- P0: Security-critical controls (auth, authz, ownership, isolation, lockout, idempotency)
- P1: Core itinerary and resource workflows
- P2: Optimization, model decisioning, notifications, and operational polish

Frozen clarification baseline (must be followed during implementation):
- Organizer scope is owner-only; admin is global.
- Refresh tokens are per-device.
- Device cap is strict at 5; 6th device login is rejected until removal.
- Unusual-city change triggers challenge with rate limit.
- Travel matrix is directed (non-symmetric).
- Missing business hours/closures means no restriction from that rule.
- Rules override model output in combined decisioning.
- Request ID is generated server-side when client omits `X-Request-Id`.

Source of frozen decisions: `docs/questions.md`.

---

## Authentication and Identity

What it does: Local username/password login with JWT, refresh tokens, device registration, and unusual-location detection.

What needs to be built:
- Registration endpoint with bcrypt password hashing
- Login endpoint with JWT issuance (access token 30 min, refresh token 14 days)
- Refresh token endpoint
- Logout (revoke refresh token)
- Password change endpoint (enforces last-5-reuse policy)
- Password recovery via security questions (no email/SMS)
- Device registration (max 5 active devices per user)
- Unusual-location detection based on last-known city string from client
- Rate-limited challenge prompts on unusual location
- Account lockout after 10 failed attempts in 15 minutes
- Audit log on login, logout, password change, device registration

---

## RBAC and Authorization

What it does: Role-based access control with permission points and menu groupings.

What needs to be built:
- Role CRUD (Admin only)
- Permission point CRUD (Admin only)
- Menu CRUD — logical capability bundles grouping permission points
- Role-to-permission-point assignment
- User-to-role assignment
- API-level authorization middleware enforcing permission points
- Data-scope rules: Organizer sees only own itineraries; Admin sees all
- Full auditability of all permission changes

---

## Itinerary Management

What it does: Create and manage travel itineraries with day-based time slots and conflict validation.

What needs to be built:
- Itinerary CRUD (title, destination, start/end dates)
- Add/update/remove items into day-based time slots (day_number + start_time + end_time)
- Conflict validation:
  - Overlap detection between items on the same day
  - Minimum 15-minute buffer between items
  - Business hours enforcement per resource
  - Closure date enforcement per resource
  - Minimum dwell time enforcement per resource
  - Travel time matrix enforcement between consecutive items
- Versioned revision records on every save (with diff metadata)
- Share token generation (valid 7 days, same deployment only)
- Itinerary export (standardized package format)
- Version history endpoint

---

## Route Planning and Optimization

What it does: Deterministic heuristic-based route optimization with explainable suggestions.

What needs to be built:
- Same-area clustering (group items by city/region)
- Shortest-path approximation (nearest-neighbor algorithm)
- Ranked suggestion list (top 3 arrangements per day)
- Explainability payload per suggestion (reason string, estimated time saved)
- Travel time matrix CRUD (per city/region, per transport mode)

---

## Resource Management

What it does: Manage attractions, lodging, meals, and meetings with business hours and closures.

What needs to be built:
- Resource CRUD (name, type, location, min dwell time)
- Business hours CRUD per resource (day-of-week, open/close time)
- Closure dates CRUD per resource (date + reason)
- Travel time matrix entries between resources

---

## Data Import/Export

What it does: Bulk import via Excel/CSV with pre-validation, deduplication, and rollback.

What needs to be built:
- Excel/CSV template download per entity type
- Bulk upload endpoint (multipart form)
- Pre-validation pass: schema, required fields, type checks — returns row-level error annotations before commit
- Deduplication by configurable key (default: resource name + street_line + city)
- Commit endpoint to apply validated rows
- Rollback endpoint (available within 10-minute window per batch)
- Import batch status and error report endpoints
- Throughput target: 10,000 rows per batch

---

## Model Management and Inference

What it does: Register, version, and run ML models locally with explainable inference.

What needs to be built:
- Model registry CRUD (name, semantic version, type: PMML/ONNX/custom)
- Activation status management (inactive, active, canary)
- A/B allocation configuration (group name + percentage)
- Canary rollout management
- Inference endpoint: execute model locally via adapter
- Combined rule-and-model decisioning
- Explainability payload: top contributing features, confidence bands, applied rules

---

## Notification Center

What it does: Fully local in-app notifications with templates, retry, and frequency caps.

What needs to be built:
- Notification template CRUD (code, subject, body with {{variable}} placeholders)
- Send notification to user (resolves template variables)
- In-app notification list per user (with read/unread filter)
- Mark notification as read
- Delivery receipts and reach stats
- Retry up to 3 times with exponential backoff for failed deliveries
- Per-user frequency cap (default 20 messages/day)
- User blacklist flag
- Outbox pattern for reliable delivery

---

## Security

What it does: Encryption, masking, strict password policy, immutable audit trail.

What needs to be built:
- bcrypt password hashing (rounds=12)
- AES-256-GCM field-level encryption for security question answers and sensitive fields
- Strict password policy: 12+ chars, complexity (upper, lower, digit, special), last 5 reuse blocked
- Masking of sensitive fields in audit log exports
- Append-only audit_logs (no DELETE for app DB role)
- Idempotency keys for all mutating operations (stored 24 hours)
- Request IDs on every request (X-Request-Id header)
- Structured logging with sensitive field masking

---

## Observability

What it does: Structured logs and database-backed job state for operational visibility.

What needs to be built:
- Winston structured JSON logging on every request/response
- Database-backed job state for import batches and notification retries
- Import batch status endpoint
- Notification delivery stats endpoint
