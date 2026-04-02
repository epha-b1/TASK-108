
# Questions and Clarifications — TripForge

---

## 1. Organizer vs Admin Data Scope — What Roles Exist?

**Question:** The prompt mentions "Organizer" and "Admin" as example roles with different data scopes. Are these the only roles, or are there more?

**Assumption:** The system ships with two seed roles: `admin` (full access) and `organizer` (own-data access). Additional roles can be created via the RBAC API. The data-scope rule is enforced at the service layer: Organizer queries are always filtered by `owner_id = currentUser.id`.

**Solution:** RBAC middleware checks permission points. A separate data-scope check in the itinerary service filters by owner_id for non-admin users.

---

## 2. Device Registration — What Is a Device Fingerprint?

**Question:** The prompt says devices are registered with a fingerprint hash. Who generates this fingerprint — the client or the server?

**Assumption:** The client generates and sends a device fingerprint string (e.g., hash of browser/app metadata). The server stores a bcrypt/SHA-256 hash of it. The server does not generate fingerprints.

**Solution:** `POST /auth/login` accepts optional `deviceFingerprint` string. Server hashes it before storing. If not provided, a server-generated UUID is used as the device identifier.

---

## 3. Unusual Location Detection — What Triggers a Challenge?

**Question:** The prompt says unusual-location detection is based on "last-known city string supplied by the client." What exactly triggers a challenge — any city change, or only a significant one?

**Assumption:** Any change in city string compared to the device's stored `last_known_city` triggers a challenge prompt. The challenge is a rate-limited 429 response with a `challengeToken`. The client must re-submit with the challenge token to proceed.

**Solution:** On login, compare `lastKnownCity` to `device.last_known_city`. If different and device is known, return 429 with a short-lived challenge token (5 min TTL). Client re-submits with `challengeToken` to confirm the new location.

---

## 4. Refresh Token — Per Device or Per User?

**Question:** The prompt says refresh tokens have a 14-day TTL. Are they scoped per device or per user?

**Assumption:** Refresh tokens are scoped per device. Each device gets its own refresh token. Revoking a device also revokes its refresh token. A user can have up to 5 active refresh tokens (one per device).

**Solution:** `refresh_tokens` table has `device_id` FK. Deleting a device cascades to its refresh token.

---

## 5. Itinerary Conflict — 15-Minute Buffer — Is It Configurable?

**Question:** The prompt says "default minimum buffer of 15 minutes between items." Does "default" imply it can be changed per itinerary or per user?

**Assumption:** The 15-minute buffer is a system-wide default enforced on all itineraries. It is not configurable per itinerary or user in this version. The word "default" in the prompt is treated as a fixed constant.

**Solution:** Buffer constant defined in config (e.g., `MIN_BUFFER_MINUTES=15`). Validation service uses this constant.

---

## 6. Travel Time Matrix — Is It Bidirectional?

**Question:** The travel time matrix stores from/to pairs. Is travel time assumed to be symmetric (A→B = B→A), or must both directions be stored?

**Assumption:** Travel times are not assumed symmetric (e.g., uphill vs downhill). Both directions must be stored explicitly. If a direction is missing, the validation service skips the travel time check for that pair (does not block scheduling).

**Solution:** `travel_time_matrices` stores directed pairs. Validation service looks up `(from, to)` specifically. Missing entry = no travel time constraint applied.

---

## 7. Itinerary Versioning — What Triggers a New Version?

**Question:** The prompt says "every save creates a versioned revision record." Does this mean every PATCH to the itinerary, or only when items are added/removed/moved?

**Assumption:** A new version is created on every mutation that changes the itinerary's content: adding/removing/updating items, and updating itinerary metadata (title, dates). Simple status changes (draft → published) do not create a new version.

**Solution:** Version creation is triggered in the service layer after any content-changing operation. Diff metadata compares the new snapshot to the previous version's snapshot.

---

## 8. Share Token — Can It Be Revoked?

**Question:** The prompt says share tokens are valid for 7 days. Can the owner revoke a share token before it expires?

**Assumption:** Yes — calling `POST /itineraries/:id/share` again generates a new token and invalidates the previous one. There is no explicit revoke endpoint; re-generating is the revocation mechanism.

**Solution:** `itineraries.share_token` is overwritten on each call to the share endpoint. Old tokens become invalid immediately.

---

## 9. Import Deduplication — What Happens to Duplicates?

**Question:** The prompt says deduplication uses a configurable key. When a duplicate is detected, is the row skipped, updated, or flagged as an error?

**Assumption:** Duplicates are skipped (not updated, not errored). The validation report marks them as `skipped_duplicate` with the matching existing record ID. The user can override this behavior by passing `deduplicationStrategy: upsert` to update existing records.

**Solution:** Import service checks for existing records by dedup key before insert. Default behavior: skip. Optional `deduplicationStrategy` param supports `skip` (default) or `upsert`.

---

## 10. Model Inference — How Are PMML/ONNX Models Executed?

**Question:** The prompt says inference runs via "Java-side adapters (PMML/ONNX or custom process)." Does this mean a Java subprocess is spawned, or is there a Java service running alongside?

**Assumption:** For this implementation, PMML/ONNX inference is handled by spawning a child process (Node.js `child_process.spawn`) that calls a bundled Java JAR or Python script. The adapter pattern abstracts the execution method. For the submission, a mock adapter is provided that returns deterministic fake results, with the real adapter interface documented.

**Solution:** `ModelAdapter` interface with `infer(input, config): Promise<InferenceResult>`. Implementations: `PmmlAdapter`, `OnnxAdapter`, `CustomAdapter`. Each spawns the appropriate process. A `MockAdapter` is used in tests.

---

## 11. Notification Frequency Cap — Per Day or Rolling Window?

**Question:** The prompt says "per-user frequency caps (default 20 messages/day)." Is this a calendar day (midnight reset) or a rolling 24-hour window?

**Assumption:** Calendar day reset at midnight UTC. A `daily_message_count` counter is reset by a scheduled job at midnight. This is simpler and more predictable than a rolling window.

**Solution:** `user_notification_settings` stores `daily_cap` (default 20). A cron job resets a `daily_sent_count` counter at midnight UTC. Notification service checks count before sending.

---

## 12. Password Recovery — How Many Security Questions?

**Question:** The prompt says password recovery uses security questions but doesn't specify how many are required.

**Assumption:** Users must set exactly 2 security questions at registration. Recovery requires correct answers to both. Questions are free-text (user writes their own question and answer).

**Solution:** Registration validates that exactly 2 security questions are provided. Recovery endpoint requires both answers to match (AES-256 decrypt + compare).

---

## 13. Idempotency Keys — Which Operations Require Them?

**Question:** The prompt says "idempotency keys for all mutating operations." Does this mean every POST/PATCH/DELETE, or only specific high-risk operations?

**Assumption:** Idempotency keys are required on: order-like operations (import upload/commit), model inference calls, and any operation explicitly marked in the API spec. Standard CRUD (create resource, update itinerary) does not require idempotency keys unless the client provides one voluntarily.

**Solution:** Idempotency middleware checks for `Idempotency-Key` header on POST requests. If present, stores and deduplicates. Required on: `POST /import/upload`, `POST /import/:id/commit`. Optional on all other POSTs.

---

## 14. A/B Allocation — How Is the Group Determined?

**Question:** The prompt mentions A/B allocations and canary rollouts for models. How is a user assigned to a group?

**Assumption:** Group assignment is deterministic based on a hash of `userId + modelName`. This ensures the same user always gets the same model version, avoiding inconsistent experiences. Percentage thresholds determine group boundaries.

**Solution:** `hash(userId + modelName) % 100` determines the user's bucket. If bucket < canary percentage, use canary model; otherwise use active model.

---

## 15. Audit Log — Which Actions Are Logged?

**Question:** The prompt says "full auditability of permission changes" and "immutable" audit logs. What is the full list of audited actions?

**Assumption:** Audited actions include: login, logout, password change, device registration/removal, user create/update/delete, role create/update/delete, permission assignment, itinerary create/update/delete, import commit/rollback, model activation, notification send.

**Solution:** Audit middleware intercepts responses and logs action + resource_type + resource_id + actor_id + IP. Sensitive fields (password_hash, encrypted answers) are masked as `[REDACTED]` in the detail JSON.

---

## 16. Device Cap — What Happens at 5 Active Devices?

**Question:** The prompt caps devices at 5 active per user. What happens when a 6th login occurs?

**Assumption:** The login is rejected with a 409 error until the user removes an existing device via `DELETE /auth/devices/{id}`. No automatic eviction.

**Solution:** On login, if a new device would exceed the cap, return `409 DEVICE_LIMIT_REACHED` and include the current device list so the client can prompt removal.

---

## 17. Unusual-Location Challenge — What Rate Limit Applies?

**Question:** The prompt requires rate-limited challenge prompts for unusual locations, but does not define the limit or window.

**Assumption:** Allow up to 3 challenge prompts per user per hour. Further attempts return `429` with a `retryAfterSeconds` value.

**Solution:** Store challenge attempts in a rolling 1-hour window keyed by user+device. Enforce the cap before issuing a new challenge token.

---

## 18. Missing Business Hours/Closures — How Should Validation Behave?

**Question:** If a resource lacks business hours or closure dates, should scheduling be blocked or allowed?

**Assumption:** Missing hours/closures mean no restriction is applied. Scheduling is allowed as long as overlap/buffer/dwell rules pass.

**Solution:** Validation checks business hours and closures only when data exists; otherwise it skips those constraints.

---

## 19. Itinerary Export — What Is the Standard Package Format?

**Question:** The prompt requires exporting a standardized itinerary package but does not specify format.

**Assumption:** Export is a JSON payload with a `schemaVersion`, itinerary metadata, day items, and linked resources; no zip container.

**Solution:** `GET /itineraries/{id}/export` returns `application/json` with the standardized schema and a `schemaVersion` field for forward compatibility.

---

## 20. Model Artifacts — How Are Files Stored or Loaded?

**Question:** Model registration is defined, but there is no upload endpoint. Where do PMML/ONNX artifacts live?

**Assumption:** Model files are placed manually in the local `models/` directory and referenced by a `filePath` in the model `config`. No network downloads.

**Solution:** The model registry stores metadata + `config.filePath`. Adapters load files from disk only.

---

## 21. Rule-and-Model Decisioning — Which Takes Precedence?

**Question:** The prompt requires combined rule-and-model decisioning. If rules and model disagree, which wins?

**Assumption:** Rules are hard constraints and override the model. The model provides a suggestion only when rules pass.

**Solution:** Apply rules first; if any rule blocks, return a rule-based decision with `appliedRules`. Otherwise return the model prediction with the rule summary included.

---

## 22. Request IDs — What If the Client Omits X-Request-Id?

**Question:** The prompt mandates request IDs on every request. Should the server generate one when absent?

**Assumption:** Yes. The server generates a UUID if `X-Request-Id` is missing and echoes it back in responses and logs.

**Solution:** Request-id middleware sets `req.id` from header or generates one, then adds `X-Request-Id` to the response.
