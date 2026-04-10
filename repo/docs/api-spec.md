openapi: "3.0.3"
info:
  title: TripForge API
  version: "1.0.0"
  description: |
    TripForge Itinerary & Decisioning Platform.
    All endpoints require Bearer JWT unless marked public.
    Base URL: http://localhost:3000
servers:
  - url: http://localhost:3000
    description: Local

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    Error:
      type: object
      required: [statusCode, code, message, requestId]
      description: |
        Canonical error envelope returned by EVERY non-2xx response. The
        `requestId` field always matches the `X-Request-Id` response header
        for the same request, so logs and client telemetry stay correlated.
      properties:
        statusCode:
          type: integer
          description: HTTP status code.
        code:
          type: string
          description: Stable machine-readable code (e.g. VALIDATION_ERROR, IDEMPOTENCY_CONFLICT).
        message:
          type: string
        requestId:
          type: string
          description: Per-request correlation id; matches the X-Request-Id response header.
        traceId:
          type: string
          description: |
            DEPRECATED alias for requestId. Carries the same value. Will be
            removed in the next major release; new clients must use requestId
            only. The deprecation timeline is documented in README.md and
            docs/design.md.
        details:
          type: object
          description: Optional structured context (validation errors, device list on 409, etc.).

security:
  - bearerAuth: []

paths:
  /health:
    get:
      tags: [Health]
      summary: Health check
      security: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:
                    type: string
                    example: ok

  /auth/register:
    post:
      tags: [Auth]
      summary: Register new user
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [username, password, securityQuestions]
              properties:
                username:
                  type: string
                password:
                  type: string
                  minLength: 12
                securityQuestions:
                  type: array
                  items:
                    type: object
                    properties:
                      question:
                        type: string
                      answer:
                        type: string
      responses:
        "201":
          description: User registered
        "409":
          description: Username already taken

  /auth/login:
    post:
      tags: [Auth]
      summary: Login
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [username, password]
              properties:
                username:
                  type: string
                password:
                  type: string
                deviceFingerprint:
                  type: string
                lastKnownCity:
                  type: string
      responses:
        "200":
          description: Login successful
          content:
            application/json:
              schema:
                type: object
                properties:
                  accessToken:
                    type: string
                  refreshToken:
                    type: string
                  user:
                    type: object
                    properties:
                      id:
                        type: string
                        format: uuid
                      username:
                        type: string
        "401":
          description: Invalid credentials
        "423":
          description: Account locked
        "429":
          description: |
            Two distinct branches share this status code, both wrapped in the
            canonical error envelope (statusCode/code/message/requestId):
              - code=CHALLENGE_REQUIRED — unusual-location detected. Body
                additionally carries top-level `challengeToken` and
                `retryAfterSeconds` so existing clients can pick them up
                without descending into a wrapper. Confirm by re-POSTing
                /auth/login with the `challengeToken` field.
              - code=RATE_LIMITED — the rolling-hour challenge limit has been
                hit (max 3 issuances per device per hour). No `challengeToken`
                in the body; `message` mentions retry timing.

  /auth/refresh:
    post:
      tags: [Auth]
      summary: Refresh access token
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [refreshToken]
              properties:
                refreshToken:
                  type: string
      responses:
        "200":
          description: New access token issued
        "401":
          description: Invalid or expired refresh token

  /auth/logout:
    post:
      tags: [Auth]
      summary: Logout (revoke refresh token)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [refreshToken]
              properties:
                refreshToken:
                  type: string
      responses:
        "204":
          description: Logged out

  /auth/change-password:
    patch:
      tags: [Auth]
      summary: Change own password
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [currentPassword, newPassword]
              properties:
                currentPassword:
                  type: string
                newPassword:
                  type: string
                  minLength: 12
      responses:
        "200":
          description: Password changed
        "400":
          description: Password reuse or policy violation

  /auth/recover:
    post:
      tags: [Auth]
      summary: Recover account via security questions
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [username, answers, newPassword]
              properties:
                username:
                  type: string
                answers:
                  type: array
                  items:
                    type: object
                    properties:
                      question:
                        type: string
                      answer:
                        type: string
                newPassword:
                  type: string
                  minLength: 12
      responses:
        "200":
          description: Password reset
        "401":
          description: Incorrect answers

  /auth/me:
    get:
      tags: [Auth]
      summary: Get current user
      responses:
        "200":
          description: Current user profile

  /auth/devices:
    get:
      tags: [Auth]
      summary: List registered devices for current user
      responses:
        "200":
          description: Device list

  /auth/devices/{id}:
    delete:
      tags: [Auth]
      summary: Remove a registered device
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "204":
          description: Device removed

  /users:
    get:
      tags: [Users]
      summary: List users (Admin only)
      parameters:
        - in: query
          name: page
          schema:
            type: integer
            default: 1
        - in: query
          name: limit
          schema:
            type: integer
            default: 20
      responses:
        "200":
          description: User list

  # NOTE: There is no POST /users in TripForge. New accounts are created by
  # /auth/register (self-service registration). Admin promotion happens by
  # PATCH /users/{id} on an existing account, not by creating one out of band.

  /users/{id}:
    get:
      tags: [Users]
      summary: Get user by ID
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: User
    patch:
      tags: [Users]
      summary: Update user status
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                status:
                  type: string
                  enum: [active, suspended, locked]
      responses:
        "200":
          description: Updated
    delete:
      tags: [Users]
      summary: Delete user (Admin only)
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "204":
          description: Deleted

  /roles:
    get:
      tags: [RBAC]
      summary: List roles
      responses:
        "200":
          description: Roles
    post:
      tags: [RBAC]
      summary: Create role (Admin only)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:
                  type: string
                description:
                  type: string
      responses:
        "201":
          description: Role created

  /roles/{id}/permissions:
    post:
      tags: [RBAC]
      summary: Assign permission points to role
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [permissionPointIds]
              properties:
                permissionPointIds:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        "200":
          description: Permissions assigned

  /users/{id}/roles:
    post:
      tags: [RBAC]
      summary: Assign roles to user
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [roleIds]
              properties:
                roleIds:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        "200":
          description: Roles assigned

  /permission-points:
    get:
      tags: [RBAC]
      summary: List permission points
      responses:
        "200":
          description: Permission points
    post:
      tags: [RBAC]
      summary: Create permission point (Admin only)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [code]
              properties:
                code:
                  type: string
                description:
                  type: string
      responses:
        "201":
          description: Created

  /menus:
    get:
      tags: [RBAC]
      summary: List menus (capability bundles)
      responses:
        "200":
          description: Menus
    post:
      tags: [RBAC]
      summary: Create menu
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:
                  type: string
                description:
                  type: string
                permissionPointIds:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        "201":
          description: Created

  /itineraries:
    get:
      tags: [Itineraries]
      summary: List itineraries (scoped to owner; Admin sees all)
      parameters:
        - in: query
          name: status
          schema:
            type: string
            enum: [draft, published, archived]
        - in: query
          name: page
          schema:
            type: integer
            default: 1
      responses:
        "200":
          description: Itineraries
    post:
      tags: [Itineraries]
      summary: Create itinerary
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title:
                  type: string
                destination:
                  type: string
                startDate:
                  type: string
                  format: date
                endDate:
                  type: string
                  format: date
      responses:
        "201":
          description: Created

  /itineraries/{id}:
    get:
      tags: [Itineraries]
      summary: Get itinerary by ID
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Itinerary
    patch:
      tags: [Itineraries]
      summary: Update itinerary
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title:
                  type: string
                destination:
                  type: string
                startDate:
                  type: string
                  format: date
                endDate:
                  type: string
                  format: date
                status:
                  type: string
                  enum: [draft, published, archived]
      responses:
        "200":
          description: Updated
    delete:
      tags: [Itineraries]
      summary: Delete itinerary
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "204":
          description: Deleted

  /itineraries/{id}/items:
    get:
      tags: [Itineraries]
      summary: List items in itinerary
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
        - in: query
          name: dayNumber
          schema:
            type: integer
      responses:
        "200":
          description: Items
    post:
      tags: [Itineraries]
      summary: Add item to itinerary
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [resourceId, dayNumber, startTime, endTime]
              properties:
                resourceId:
                  type: string
                  format: uuid
                dayNumber:
                  type: integer
                startTime:
                  type: string
                  example: "09:00"
                endTime:
                  type: string
                  example: "11:00"
                notes:
                  type: string
      responses:
        "201":
          description: Item added
        "400":
          description: Business hours or dwell time violation
        "409":
          description: Time conflict or buffer violation

  /itineraries/{id}/items/{itemId}:
    patch:
      tags: [Itineraries]
      summary: Update itinerary item
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
        - in: path
          name: itemId
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                startTime:
                  type: string
                endTime:
                  type: string
                notes:
                  type: string
      responses:
        "200":
          description: Updated
    delete:
      tags: [Itineraries]
      summary: Remove item from itinerary
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
        - in: path
          name: itemId
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "204":
          description: Removed

  /itineraries/{id}/optimize:
    get:
      tags: [Itineraries]
      summary: Get route optimization suggestions
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
        - in: query
          name: dayNumber
          schema:
            type: integer
      responses:
        "200":
          description: Ranked optimization suggestions with explainability

  /itineraries/{id}/versions:
    get:
      tags: [Itineraries]
      summary: Get version history
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Version history

  /itineraries/{id}/share:
    post:
      tags: [Itineraries]
      summary: Generate share token (valid 7 days)
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Share token and URL

  /itineraries/{id}/export:
    get:
      tags: [Itineraries]
      summary: Export itinerary package
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Itinerary export package (JSON)

  /shared/{token}:
    get:
      tags: [Itineraries]
      summary: View shared itinerary by token (public)
      security: []
      parameters:
        - in: path
          name: token
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Shared itinerary
        "404":
          description: Token not found or expired

  /resources:
    get:
      tags: [Resources]
      summary: List resources
      parameters:
        - in: query
          name: type
          schema:
            type: string
            enum: [attraction, lodging, meal, meeting]
        - in: query
          name: city
          schema:
            type: string
        - in: query
          name: page
          schema:
            type: integer
            default: 1
      responses:
        "200":
          description: Resources
    post:
      tags: [Resources]
      summary: Create resource
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, type]
              properties:
                name:
                  type: string
                type:
                  type: string
                  enum: [attraction, lodging, meal, meeting]
                streetLine:
                  type: string
                city:
                  type: string
                region:
                  type: string
                country:
                  type: string
                latitude:
                  type: number
                longitude:
                  type: number
                minDwellMinutes:
                  type: integer
                  default: 30
      responses:
        "201":
          description: Created

  /resources/{id}:
    get:
      tags: [Resources]
      summary: Get resource
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Resource
    patch:
      tags: [Resources]
      summary: Update resource
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Updated
    delete:
      tags: [Resources]
      summary: Delete resource
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "204":
          description: Deleted

  /resources/{id}/hours:
    get:
      tags: [Resources]
      summary: Get business hours for resource
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Business hours
    post:
      tags: [Resources]
      summary: Set business hours
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [dayOfWeek, openTime, closeTime]
              properties:
                dayOfWeek:
                  type: integer
                  minimum: 0
                  maximum: 6
                openTime:
                  type: string
                  example: "09:00"
                closeTime:
                  type: string
                  example: "18:00"
      responses:
        "201":
          description: Hours set

  /resources/{id}/closures:
    get:
      tags: [Resources]
      summary: Get closure dates for resource
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Closures
    post:
      tags: [Resources]
      summary: Add closure date
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [date]
              properties:
                date:
                  type: string
                  format: date
                reason:
                  type: string
      responses:
        "201":
          description: Closure added

  /travel-times:
    get:
      tags: [Resources]
      summary: List travel time matrix entries
      parameters:
        - in: query
          name: fromResourceId
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Travel time entries
    post:
      tags: [Resources]
      summary: Create or update travel time entry
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [fromResourceId, toResourceId, travelMinutes]
              properties:
                fromResourceId:
                  type: string
                  format: uuid
                toResourceId:
                  type: string
                  format: uuid
                travelMinutes:
                  type: integer
                transportMode:
                  type: string
                  enum: [walking, driving, transit]
                  default: walking
      responses:
        "200":
          description: Travel time set

  /import/templates/{entityType}:
    get:
      tags: [Import]
      summary: Download Excel/CSV template for entity type
      security: []
      parameters:
        - in: path
          name: entityType
          required: true
          schema:
            type: string
            enum: [resources, itineraries]
        - in: query
          name: format
          required: false
          schema:
            type: string
            enum: [xlsx, csv]
            default: xlsx
          description: |
            Template format. Defaults to `xlsx` for backwards compatibility.
            Pass `csv` for the CSV variant. Format can also be selected via
            the `Accept` request header — `text/csv` returns CSV, anything
            else returns XLSX.
      responses:
        "200":
          description: Template file (xlsx or csv depending on the `format` query parameter)
          content:
            application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
              schema:
                type: string
                format: binary
            text/csv:
              schema:
                type: string

  /import/upload:
    post:
      tags: [Import]
      summary: Upload file for bulk import (pre-validation only)
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file, entityType, idempotencyKey]
              properties:
                file:
                  type: string
                  format: binary
                entityType:
                  type: string
                idempotencyKey:
                  type: string
                deduplicationKey:
                  type: string
                  description: |
                    Ordered field list for resource dedup. Canonical format is
                    comma-separated, e.g. `name,streetLine,city`. The legacy
                    `+` separator (e.g. `name+streetLine+city`) is still
                    accepted for backwards compatibility but is deprecated.
                    Default when omitted: `name,streetLine,city`.
      responses:
        "200":
          description: Validation report with row-level errors
          content:
            application/json:
              schema:
                type: object
                properties:
                  batchId:
                    type: string
                    format: uuid
                  totalRows:
                    type: integer
                  validRows:
                    type: integer
                  errorRows:
                    type: integer
                  errors:
                    type: array
                    items:
                      type: object
                      properties:
                        rowNumber:
                          type: integer
                        field:
                          type: string
                        message:
                          type: string

  /import/{batchId}/commit:
    post:
      tags: [Import]
      summary: Commit validated import batch
      parameters:
        - in: path
          name: batchId
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Import committed
        "409":
          description: Batch already committed or rolled back

  /import/{batchId}/rollback:
    post:
      tags: [Import]
      summary: Rollback import batch (within 10-minute window)
      parameters:
        - in: path
          name: batchId
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Rolled back
        "409":
          description: Rollback window expired

  /import/{batchId}:
    get:
      tags: [Import]
      summary: Get import batch status and error report
      parameters:
        - in: path
          name: batchId
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Batch status and errors

  /models:
    get:
      tags: [Models]
      summary: List registered models
      responses:
        "200":
          description: Models
    post:
      tags: [Models]
      summary: Register a model
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, version, type]
              properties:
                name:
                  type: string
                version:
                  type: string
                  description: Semantic version (e.g. 1.2.0)
                type:
                  type: string
                  enum: [pmml, onnx, custom]
                config:
                  type: object
      responses:
        "201":
          description: Model registered

  /models/{id}:
    get:
      tags: [Models]
      summary: Get model details
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Model
    patch:
      tags: [Models]
      summary: Update model status
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                status:
                  type: string
                  enum: [inactive, active, canary]
      responses:
        "200":
          description: Updated

  /models/{id}/ab-allocations:
    post:
      tags: [Models]
      summary: Set A/B allocation for model
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [groupName, percentage]
              properties:
                groupName:
                  type: string
                percentage:
                  type: number
                  minimum: 0
                  maximum: 100
      responses:
        "200":
          description: Allocation set

  /models/{id}/infer:
    post:
      tags: [Models]
      summary: Run inference on model
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [input]
              properties:
                input:
                  type: object
                context:
                  type: object
      responses:
        "200":
          description: Inference result with explainability
          content:
            application/json:
              schema:
                type: object
                properties:
                  prediction:
                    type: object
                  confidence:
                    type: number
                  confidenceBand:
                    type: array
                    items:
                      type: number
                  topFeatures:
                    type: array
                    items:
                      type: object
                      properties:
                        feature:
                          type: string
                        contribution:
                          type: number
                  appliedRules:
                    type: array
                    items:
                      type: object
                      properties:
                        rule:
                          type: string
                        triggered:
                          type: boolean

  /notifications:
    get:
      tags: [Notifications]
      summary: List notifications for current user
      parameters:
        - in: query
          name: read
          schema:
            type: boolean
        - in: query
          name: page
          schema:
            type: integer
            default: 1
      responses:
        "200":
          description: Notifications
    post:
      tags: [Notifications]
      summary: Send notification to user (requires notification:write)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [userId, type]
              properties:
                userId:
                  type: string
                  format: uuid
                type:
                  type: string
                templateCode:
                  type: string
                variables:
                  type: object
                subject:
                  type: string
                message:
                  type: string
      responses:
        "201":
          description: Notification sent

  /notifications/{id}/read:
    patch:
      tags: [Notifications]
      summary: Mark notification as read
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Marked read

  /notifications/stats:
    get:
      tags: [Notifications]
      summary: Get notification delivery stats (Admin only)
      responses:
        "200":
          description: Delivery stats

  /notification-templates:
    get:
      tags: [Notifications]
      summary: List notification templates
      responses:
        "200":
          description: Templates
    post:
      tags: [Notifications]
      summary: Create notification template
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [code, body]
              properties:
                code:
                  type: string
                subject:
                  type: string
                body:
                  type: string
                  description: Supports {{variable}} placeholders
      responses:
        "201":
          description: Template created

  /notification-templates/{id}:
    patch:
      tags: [Notifications]
      summary: Update notification template
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Updated

  /audit-logs:
    get:
      tags: [Audit]
      summary: Query audit log (Admin only)
      parameters:
        - in: query
          name: actorId
          schema:
            type: string
            format: uuid
        - in: query
          name: action
          schema:
            type: string
        - in: query
          name: resourceType
          schema:
            type: string
        - in: query
          name: from
          schema:
            type: string
            format: date-time
        - in: query
          name: to
          schema:
            type: string
            format: date-time
        - in: query
          name: page
          schema:
            type: integer
            default: 1
      responses:
        "200":
          description: Audit log entries

  /audit-logs/export:
    get:
      tags: [Audit]
      summary: Export audit log as CSV (sensitive fields masked)
      parameters:
        - in: query
          name: from
          schema:
            type: string
            format: date-time
        - in: query
          name: to
          schema:
            type: string
            format: date-time
      responses:
        "200":
          description: CSV export
          content:
            text/csv:
              schema:
                type: string

tags:
  - name: Health
  - name: Auth
  - name: Users
  - name: RBAC
  - name: Itineraries
  - name: Resources
  - name: Import
  - name: Models
  - name: Notifications
  - name: Audit
