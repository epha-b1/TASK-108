// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const apiSpec: any = {
  openapi: '3.0.3',
  info: {
    title: 'TripForge API',
    version: '1.0.0',
    description: 'TripForge Itinerary & Decisioning Platform. All endpoints require Bearer JWT unless marked public.',
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    parameters: {
      IdempotencyKey: {
        in: 'header', name: 'Idempotency-Key', required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Required on all POST/PATCH/DELETE. Same key+actor+payload = cached response. Same key+different context = 409. Missing key = 400.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['statusCode', 'code', 'message', 'requestId'],
        properties: {
          statusCode: { type: 'integer' },
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string', description: 'Per-request correlation id; matches the X-Request-Id response header. Always present on every error response.' },
          traceId: { type: 'string', description: 'DEPRECATED alias for requestId. Carries the same value. Will be removed in the next major release; new clients must use requestId only.' },
          details: { type: 'object', description: 'Additional context (e.g. device list on 409)' },
        },
      },
      ChallengeResponse: {
        type: 'object',
        description:
          'CHALLENGE_REQUIRED 429 envelope returned by POST /auth/login when an unusual location is detected for a known device. ' +
          'Carries the canonical error envelope fields (statusCode/code/message/requestId) PLUS top-level challengeToken + retryAfterSeconds for clients that need them. ' +
          'When the rolling-hour challenge limit is exceeded the same endpoint returns the canonical envelope with code=RATE_LIMITED and no challengeToken.',
        required: ['statusCode', 'code', 'message', 'requestId', 'challengeToken', 'retryAfterSeconds'],
        properties: {
          statusCode: { type: 'integer', example: 429 },
          code: { type: 'string', example: 'CHALLENGE_REQUIRED' },
          message: { type: 'string', example: 'Unusual location detected. Please confirm your identity.' },
          requestId: { type: 'string', description: 'Per-request correlation id; matches the X-Request-Id response header.' },
          traceId: { type: 'string', description: 'DEPRECATED alias for requestId.' },
          challengeToken: { type: 'string', format: 'uuid' },
          retryAfterSeconds: { type: 'integer', example: 300 },
        },
      },
      DeviceLimitError: {
        type: 'object',
        properties: {
          statusCode: { type: 'integer', example: 409 },
          code: { type: 'string', example: 'DEVICE_LIMIT_REACHED' },
          message: { type: 'string' },
          details: {
            type: 'object',
            properties: {
              devices: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, lastSeenAt: { type: 'string' }, lastKnownCity: { type: 'string' } } } },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Users' },
    { name: 'RBAC' },
    { name: 'Resources' },
    { name: 'Itineraries' },
    { name: 'Import' },
    { name: 'Models' },
    { name: 'Notifications' },
    { name: 'Audit' },
  ],
  paths: {
    '/health': {
      get: { tags: ['Health'], summary: 'Health check', security: [], responses: { '200': { description: 'OK' } } },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'], summary: 'Register new user', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username', 'password', 'securityQuestions'], properties: { username: { type: 'string' }, password: { type: 'string', minLength: 12 }, securityQuestions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } } } } } } } } },
        responses: { '201': { description: 'User registered' }, '409': { description: 'Username taken' } },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Login', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string' }, deviceFingerprint: { type: 'string' }, lastKnownCity: { type: 'string' }, challengeToken: { type: 'string', description: 'Token from previous 429 challenge response' } } } } } },
        responses: { '200': { description: 'Login successful' }, '401': { description: 'Invalid credentials' }, '409': { description: 'Device limit reached', content: { 'application/json': { schema: { '$ref': '#/components/schemas/DeviceLimitError' } } } }, '423': { description: 'Account locked (10 failures in rolling 15 min)' }, '429': { description: 'Unusual location — challenge required', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ChallengeResponse' } } } } },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'], summary: 'Refresh access token', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } } } } },
        responses: { '200': { description: 'New access token' }, '401': { description: 'Invalid refresh token' } },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'], summary: 'Logout (revoke refresh token)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } } } } },
        responses: { '204': { description: 'Logged out' } },
      },
    },
    '/auth/change-password': {
      patch: {
        tags: ['Auth'], summary: 'Change own password',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 12 } } } } } },
        responses: { '200': { description: 'Password changed' }, '400': { description: 'Policy violation or reuse' } },
      },
    },
    '/auth/recover': {
      post: {
        tags: ['Auth'], summary: 'Recover account via security questions', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username', 'answers', 'newPassword'], properties: { username: { type: 'string' }, answers: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } } } }, newPassword: { type: 'string', minLength: 12 } } } } } },
        responses: { '200': { description: 'Password reset' }, '401': { description: 'Incorrect answers' } },
      },
    },
    '/auth/me': {
      get: { tags: ['Auth'], summary: 'Get current user profile', responses: { '200': { description: 'User profile' } } },
    },
    '/auth/devices': {
      get: { tags: ['Auth'], summary: 'List registered devices', responses: { '200': { description: 'Device list' } } },
    },
    '/auth/devices/{id}': {
      delete: {
        tags: ['Auth'], summary: 'Remove a registered device',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '204': { description: 'Device removed' } },
      },
    },
    '/users': {
      get: {
        tags: ['Users'], summary: 'List users (Admin only)',
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'User list' } },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'], summary: 'Get user by ID',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'User' } },
      },
      patch: {
        tags: ['Users'], summary: 'Update user status (Admin only)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'suspended', 'locked'] } } } } } },
        responses: { '200': { description: 'Updated' } },
      },
      delete: {
        tags: ['Users'], summary: 'Delete user (Admin only)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/users/{id}/roles': {
      post: {
        tags: ['RBAC'], summary: 'Assign roles to user (Admin only)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['roleIds'], properties: { roleIds: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } },
        responses: { '200': { description: 'Roles assigned' } },
      },
    },
    '/roles': {
      get: { tags: ['RBAC'], summary: 'List roles', responses: { '200': { description: 'Roles' } } },
      post: {
        tags: ['RBAC'], summary: 'Create role (Admin only)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } } } },
        responses: { '201': { description: 'Role created' } },
      },
    },
    '/roles/{id}/permissions': {
      post: {
        tags: ['RBAC'], summary: 'Assign permission points to role (Admin only)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['permissionPointIds'], properties: { permissionPointIds: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } },
        responses: { '200': { description: 'Permissions assigned' } },
      },
    },
    '/permission-points': {
      get: { tags: ['RBAC'], summary: 'List permission points', responses: { '200': { description: 'Permission points' } } },
      post: {
        tags: ['RBAC'], summary: 'Create permission point (Admin only)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, description: { type: 'string' } } } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/menus': {
      get: { tags: ['RBAC'], summary: 'List menus (capability bundles)', responses: { '200': { description: 'Menus' } } },
      post: {
        tags: ['RBAC'], summary: 'Create menu (Admin only)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, permissionPointIds: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/resources': {
      get: {
        tags: ['Resources'], summary: 'List resources',
        parameters: [
          { in: 'query', name: 'type', schema: { type: 'string', enum: ['attraction', 'lodging', 'meal', 'meeting'] } },
          { in: 'query', name: 'city', schema: { type: 'string' } },
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        ],
        responses: { '200': { description: 'Resources' } },
      },
      post: {
        tags: ['Resources'], summary: 'Create resource',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['attraction', 'lodging', 'meal', 'meeting'] }, streetLine: { type: 'string' }, city: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, minDwellMinutes: { type: 'integer', default: 30 } } } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/resources/{id}': {
      get: {
        tags: ['Resources'], summary: 'Get resource',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Resource with hours and closures' } },
      },
      patch: {
        tags: ['Resources'], summary: 'Update resource',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Updated' } },
      },
      delete: {
        tags: ['Resources'], summary: 'Delete resource',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/resources/{id}/hours': {
      get: {
        tags: ['Resources'], summary: 'Get business hours',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Business hours' } },
      },
      post: {
        tags: ['Resources'], summary: 'Set business hours',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['dayOfWeek', 'openTime', 'closeTime'], properties: { dayOfWeek: { type: 'integer', minimum: 0, maximum: 6 }, openTime: { type: 'string', example: '09:00' }, closeTime: { type: 'string', example: '18:00' } } } } } },
        responses: { '201': { description: 'Hours set' } },
      },
    },
    '/resources/{id}/closures': {
      get: {
        tags: ['Resources'], summary: 'Get closure dates',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Closures' } },
      },
      post: {
        tags: ['Resources'], summary: 'Add closure date',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['date'], properties: { date: { type: 'string', format: 'date' }, reason: { type: 'string' } } } } } },
        responses: { '201': { description: 'Closure added' } },
      },
    },
    '/travel-times': {
      get: {
        tags: ['Resources'], summary: 'List travel time entries',
        parameters: [{ in: 'query', name: 'fromResourceId', schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Travel time entries' } },
      },
      post: {
        tags: ['Resources'], summary: 'Create or update travel time entry',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fromResourceId', 'toResourceId', 'travelMinutes'], properties: { fromResourceId: { type: 'string', format: 'uuid' }, toResourceId: { type: 'string', format: 'uuid' }, travelMinutes: { type: 'integer' }, transportMode: { type: 'string', enum: ['walking', 'driving', 'transit'], default: 'walking' } } } } } },
        responses: { '200': { description: 'Travel time set' } },
      },
    },
    '/itineraries': {
      get: {
        tags: ['Itineraries'], summary: 'List itineraries (scoped by role)',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['draft', 'published', 'archived'] } },
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        ],
        responses: { '200': { description: 'Itineraries' } },
      },
      post: {
        tags: ['Itineraries'], summary: 'Create itinerary',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, destination: { type: 'string' }, startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' } } } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/itineraries/{id}': {
      get: {
        tags: ['Itineraries'], summary: 'Get itinerary',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Itinerary with items' } },
      },
      patch: {
        tags: ['Itineraries'], summary: 'Update itinerary',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, destination: { type: 'string' }, startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' }, status: { type: 'string', enum: ['draft', 'published', 'archived'] } } } } } },
        responses: { '200': { description: 'Updated' } },
      },
      delete: {
        tags: ['Itineraries'], summary: 'Delete itinerary',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/itineraries/{id}/items': {
      get: {
        tags: ['Itineraries'], summary: 'List items in itinerary',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'dayNumber', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Items' } },
      },
      post: {
        tags: ['Itineraries'], summary: 'Add item to itinerary',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['resourceId', 'dayNumber', 'startTime', 'endTime'], properties: { resourceId: { type: 'string', format: 'uuid' }, dayNumber: { type: 'integer' }, startTime: { type: 'string', example: '09:00' }, endTime: { type: 'string', example: '11:00' }, notes: { type: 'string' } } } } } },
        responses: { '201': { description: 'Item added' }, '400': { description: 'Business hours or dwell time violation' }, '409': { description: 'Time conflict or buffer violation' } },
      },
    },
    '/itineraries/{id}/items/{itemId}': {
      patch: {
        tags: ['Itineraries'], summary: 'Update itinerary item',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
          { in: 'path', name: 'itemId', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Updated' } },
      },
      delete: {
        tags: ['Itineraries'], summary: 'Remove item from itinerary',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
          { in: 'path', name: 'itemId', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '204': { description: 'Removed' } },
      },
    },
    '/itineraries/{id}/optimize': {
      get: {
        tags: ['Itineraries'], summary: 'Get route optimization suggestions',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'dayNumber', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Ranked optimization suggestions with explainability' } },
      },
    },
    '/itineraries/{id}/versions': {
      get: {
        tags: ['Itineraries'], summary: 'Get version history',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Version history' } },
      },
    },
    '/itineraries/{id}/share': {
      post: {
        tags: ['Itineraries'], summary: 'Generate share token (valid 7 days)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Share token and URL' } },
      },
    },
    '/itineraries/{id}/export': {
      get: {
        tags: ['Itineraries'], summary: 'Export itinerary package (JSON)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Itinerary export package' } },
      },
    },
    '/shared/{token}': {
      get: {
        tags: ['Itineraries'], summary: 'View shared itinerary by token (public)', security: [],
        parameters: [{ in: 'path', name: 'token', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Shared itinerary' }, '404': { description: 'Token not found or expired' } },
      },
    },
    '/import/templates/{entityType}': {
      get: {
        tags: ['Import'], summary: 'Download Excel template (public)', security: [],
        parameters: [{ in: 'path', name: 'entityType', required: true, schema: { type: 'string', enum: ['resources', 'itineraries'] } }],
        responses: { '200': { description: 'Template file (xlsx)' } },
      },
    },
    '/import/upload': {
      post: {
        tags: ['Import'], summary: 'Upload file for bulk import (pre-validation)',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'entityType', 'idempotencyKey'], properties: { file: { type: 'string', format: 'binary' }, entityType: { type: 'string' }, idempotencyKey: { type: 'string' }, deduplicationKey: { type: 'string', description: 'Comma-separated field list for resource dedup (canonical, e.g. `name,streetLine,city`). Legacy `+` separator is still accepted but deprecated. Default: `name,streetLine,city`.' } } } } } },
        responses: { '200': { description: 'Validation report with row-level errors' } },
      },
    },
    '/import/{batchId}/commit': {
      post: {
        tags: ['Import'], summary: 'Commit validated import batch',
        parameters: [{ in: 'path', name: 'batchId', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Import committed' }, '409': { description: 'Already committed or rolled back' } },
      },
    },
    '/import/{batchId}/rollback': {
      post: {
        tags: ['Import'], summary: 'Rollback import batch (within 10-min window)',
        parameters: [{ in: 'path', name: 'batchId', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Rolled back' }, '409': { description: 'Rollback window expired' } },
      },
    },
    '/import/{batchId}': {
      get: {
        tags: ['Import'], summary: 'Get import batch status and errors',
        parameters: [{ in: 'path', name: 'batchId', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Batch status with errors' } },
      },
    },
    '/models': {
      get: { tags: ['Models'], summary: 'List registered models', responses: { '200': { description: 'Models' } } },
      post: {
        tags: ['Models'], summary: 'Register a model',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'version', 'type'], properties: { name: { type: 'string' }, version: { type: 'string', description: 'Semantic version' }, type: { type: 'string', enum: ['pmml', 'onnx', 'custom'] }, config: { type: 'object' } } } } } },
        responses: { '201': { description: 'Model registered' } },
      },
    },
    '/models/{id}': {
      get: {
        tags: ['Models'], summary: 'Get model details',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Model with allocations' } },
      },
      patch: {
        tags: ['Models'], summary: 'Update model status',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['inactive', 'active', 'canary'] } } } } } },
        responses: { '200': { description: 'Updated' } },
      },
    },
    '/models/{id}/ab-allocations': {
      post: {
        tags: ['Models'], summary: 'Set A/B allocation (Admin only)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['groupName', 'percentage'], properties: { groupName: { type: 'string' }, percentage: { type: 'number', minimum: 0, maximum: 100 } } } } } },
        responses: { '200': { description: 'Allocation set' } },
      },
    },
    '/models/{id}/infer': {
      post: {
        tags: ['Models'], summary: 'Run inference on model',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: { input: { type: 'object' }, context: { type: 'object' } } } } } },
        responses: { '200': { description: 'Inference result with explainability payload' } },
      },
    },
    '/notifications': {
      get: {
        tags: ['Notifications'], summary: 'List notifications for current user',
        parameters: [
          { in: 'query', name: 'read', schema: { type: 'boolean' } },
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        ],
        responses: { '200': { description: 'Notifications' } },
      },
      post: {
        tags: ['Notifications'], summary: 'Send notification to user',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId', 'type'], properties: { userId: { type: 'string', format: 'uuid' }, type: { type: 'string' }, templateCode: { type: 'string' }, variables: { type: 'object' }, subject: { type: 'string' }, message: { type: 'string' } } } } } },
        responses: { '201': { description: 'Notification sent' } },
      },
    },
    '/notifications/{id}/read': {
      patch: {
        tags: ['Notifications'], summary: 'Mark notification as read',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Marked read' } },
      },
    },
    '/notifications/stats': {
      get: { tags: ['Notifications'], summary: 'Get notification delivery stats (Admin only)', responses: { '200': { description: 'Delivery stats' } } },
    },
    '/notification-templates': {
      get: { tags: ['Notifications'], summary: 'List notification templates', responses: { '200': { description: 'Templates' } } },
      post: {
        tags: ['Notifications'], summary: 'Create notification template (Admin only)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code', 'body'], properties: { code: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Supports {{variable}} placeholders' } } } } } },
        responses: { '201': { description: 'Template created' } },
      },
    },
    '/notification-templates/{id}': {
      patch: {
        tags: ['Notifications'], summary: 'Update notification template (Admin only)',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Updated' } },
      },
    },
    '/audit-logs': {
      get: {
        tags: ['Audit'], summary: 'Query audit log (Admin only)',
        parameters: [
          { in: 'query', name: 'actorId', schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'action', schema: { type: 'string' } },
          { in: 'query', name: 'resourceType', schema: { type: 'string' } },
          { in: 'query', name: 'from', schema: { type: 'string', format: 'date-time' } },
          { in: 'query', name: 'to', schema: { type: 'string', format: 'date-time' } },
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        ],
        responses: { '200': { description: 'Audit log entries' } },
      },
    },
    '/audit-logs/export': {
      get: {
        tags: ['Audit'], summary: 'Export audit log as CSV (sensitive fields masked)',
        parameters: [
          { in: 'query', name: 'from', schema: { type: 'string', format: 'date-time' } },
          { in: 'query', name: 'to', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'CSV export', content: { 'text/csv': { schema: { type: 'string' } } } } },
      },
    },
  },
};

// Auto-inject IdempotencyKey parameter reference into all POST/PATCH/DELETE operations
const idempotencyRef = { '$ref': '#/components/parameters/IdempotencyKey' };
for (const pathObj of Object.values(apiSpec.paths)) {
  for (const [method, op] of Object.entries(pathObj as Record<string, any>)) {
    if (['post', 'patch', 'delete'].includes(method) && op && typeof op === 'object') {
      if (!op.parameters) op.parameters = [];
      const already = op.parameters.some((p: any) => p.$ref === idempotencyRef.$ref || p.name === 'Idempotency-Key');
      if (!already) op.parameters.push(idempotencyRef);
    }
  }
}
