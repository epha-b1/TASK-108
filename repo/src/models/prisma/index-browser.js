
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  getRuntime,
  skip
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.22.0
 * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
 */
Prisma.prismaVersion = {
  client: "5.22.0",
  engine: "605197351a3c8bdd595af2d2a9bc3025bca48ea2"
}

Prisma.PrismaClientKnownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientKnownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientUnknownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientRustPanicError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientInitializationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientValidationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`NotFoundError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`sqltag is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`empty is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`join is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`raw is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.getExtensionContext is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.defineExtension is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}



/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  ReadUncommitted: 'ReadUncommitted',
  ReadCommitted: 'ReadCommitted',
  RepeatableRead: 'RepeatableRead',
  Serializable: 'Serializable'
});

exports.Prisma.AuditLogScalarFieldEnum = {
  id: 'id',
  action: 'action',
  detail: 'detail',
  traceId: 'traceId',
  createdAt: 'createdAt'
};

exports.Prisma.UserScalarFieldEnum = {
  id: 'id',
  username: 'username',
  passwordHash: 'passwordHash',
  role: 'role',
  status: 'status',
  failedAttempts: 'failedAttempts',
  lockedUntil: 'lockedUntil',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SecurityQuestionScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  question: 'question',
  answerEncrypted: 'answerEncrypted',
  createdAt: 'createdAt'
};

exports.Prisma.DeviceScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  fingerprintHash: 'fingerprintHash',
  lastSeenAt: 'lastSeenAt',
  lastKnownCity: 'lastKnownCity',
  createdAt: 'createdAt'
};

exports.Prisma.RefreshTokenScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  deviceId: 'deviceId',
  tokenHash: 'tokenHash',
  expiresAt: 'expiresAt',
  revokedAt: 'revokedAt',
  createdAt: 'createdAt'
};

exports.Prisma.PasswordHistoryScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  passwordHash: 'passwordHash',
  createdAt: 'createdAt'
};

exports.Prisma.LoginAttemptScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  success: 'success',
  ipAddress: 'ipAddress',
  createdAt: 'createdAt'
};

exports.Prisma.RoleScalarFieldEnum = {
  id: 'id',
  name: 'name',
  description: 'description',
  createdAt: 'createdAt'
};

exports.Prisma.PermissionPointScalarFieldEnum = {
  id: 'id',
  code: 'code',
  description: 'description',
  createdAt: 'createdAt'
};

exports.Prisma.MenuScalarFieldEnum = {
  id: 'id',
  name: 'name',
  description: 'description',
  createdAt: 'createdAt'
};

exports.Prisma.MenuPermissionPointScalarFieldEnum = {
  menuId: 'menuId',
  permissionPointId: 'permissionPointId'
};

exports.Prisma.RolePermissionPointScalarFieldEnum = {
  roleId: 'roleId',
  permissionPointId: 'permissionPointId'
};

exports.Prisma.UserRoleScalarFieldEnum = {
  userId: 'userId',
  roleId: 'roleId'
};

exports.Prisma.ResourceScalarFieldEnum = {
  id: 'id',
  name: 'name',
  type: 'type',
  streetLine: 'streetLine',
  city: 'city',
  region: 'region',
  country: 'country',
  latitude: 'latitude',
  longitude: 'longitude',
  minDwellMinutes: 'minDwellMinutes',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ResourceHourScalarFieldEnum = {
  id: 'id',
  resourceId: 'resourceId',
  dayOfWeek: 'dayOfWeek',
  openTime: 'openTime',
  closeTime: 'closeTime'
};

exports.Prisma.ResourceClosureScalarFieldEnum = {
  id: 'id',
  resourceId: 'resourceId',
  date: 'date',
  reason: 'reason'
};

exports.Prisma.TravelTimeMatrixScalarFieldEnum = {
  id: 'id',
  fromResourceId: 'fromResourceId',
  toResourceId: 'toResourceId',
  travelMinutes: 'travelMinutes',
  transportMode: 'transportMode',
  updatedAt: 'updatedAt'
};

exports.Prisma.ItineraryScalarFieldEnum = {
  id: 'id',
  ownerId: 'ownerId',
  title: 'title',
  destination: 'destination',
  startDate: 'startDate',
  endDate: 'endDate',
  status: 'status',
  shareToken: 'shareToken',
  shareExpiresAt: 'shareExpiresAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ItineraryVersionScalarFieldEnum = {
  id: 'id',
  itineraryId: 'itineraryId',
  versionNumber: 'versionNumber',
  snapshot: 'snapshot',
  diffMetadata: 'diffMetadata',
  createdBy: 'createdBy',
  createdAt: 'createdAt'
};

exports.Prisma.ItineraryItemScalarFieldEnum = {
  id: 'id',
  itineraryId: 'itineraryId',
  resourceId: 'resourceId',
  dayNumber: 'dayNumber',
  startTime: 'startTime',
  endTime: 'endTime',
  notes: 'notes',
  position: 'position',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ImportBatchScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  entityType: 'entityType',
  status: 'status',
  totalRows: 'totalRows',
  successRows: 'successRows',
  errorRows: 'errorRows',
  idempotencyKey: 'idempotencyKey',
  rollbackUntil: 'rollbackUntil',
  validatedData: 'validatedData',
  createdAt: 'createdAt',
  completedAt: 'completedAt'
};

exports.Prisma.ImportErrorScalarFieldEnum = {
  id: 'id',
  batchId: 'batchId',
  rowNumber: 'rowNumber',
  field: 'field',
  message: 'message',
  rawData: 'rawData'
};

exports.Prisma.MlModelScalarFieldEnum = {
  id: 'id',
  name: 'name',
  version: 'version',
  type: 'type',
  status: 'status',
  filePath: 'filePath',
  config: 'config',
  createdAt: 'createdAt'
};

exports.Prisma.AbAllocationScalarFieldEnum = {
  id: 'id',
  modelId: 'modelId',
  groupName: 'groupName',
  percentage: 'percentage',
  createdAt: 'createdAt'
};

exports.Prisma.NotificationTemplateScalarFieldEnum = {
  id: 'id',
  code: 'code',
  subject: 'subject',
  body: 'body',
  createdAt: 'createdAt'
};

exports.Prisma.NotificationScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  templateId: 'templateId',
  type: 'type',
  subject: 'subject',
  message: 'message',
  read: 'read',
  delivered: 'delivered',
  retryCount: 'retryCount',
  nextRetryAt: 'nextRetryAt',
  createdAt: 'createdAt'
};

exports.Prisma.OutboxMessageScalarFieldEnum = {
  id: 'id',
  notificationId: 'notificationId',
  status: 'status',
  attempts: 'attempts',
  lastError: 'lastError',
  createdAt: 'createdAt',
  deliveredAt: 'deliveredAt'
};

exports.Prisma.UserNotificationSettingScalarFieldEnum = {
  userId: 'userId',
  blacklisted: 'blacklisted',
  dailyCap: 'dailyCap',
  dailySent: 'dailySent',
  updatedAt: 'updatedAt'
};

exports.Prisma.IdempotencyKeyScalarFieldEnum = {
  key: 'key',
  operationType: 'operationType',
  responseBody: 'responseBody',
  createdAt: 'createdAt',
  expiresAt: 'expiresAt'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.NullableJsonNullValueInput = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull
};

exports.Prisma.JsonNullValueInput = {
  JsonNull: Prisma.JsonNull
};

exports.Prisma.JsonNullValueFilter = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull,
  AnyNull: Prisma.AnyNull
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};


exports.Prisma.ModelName = {
  AuditLog: 'AuditLog',
  User: 'User',
  SecurityQuestion: 'SecurityQuestion',
  Device: 'Device',
  RefreshToken: 'RefreshToken',
  PasswordHistory: 'PasswordHistory',
  LoginAttempt: 'LoginAttempt',
  Role: 'Role',
  PermissionPoint: 'PermissionPoint',
  Menu: 'Menu',
  MenuPermissionPoint: 'MenuPermissionPoint',
  RolePermissionPoint: 'RolePermissionPoint',
  UserRole: 'UserRole',
  Resource: 'Resource',
  ResourceHour: 'ResourceHour',
  ResourceClosure: 'ResourceClosure',
  TravelTimeMatrix: 'TravelTimeMatrix',
  Itinerary: 'Itinerary',
  ItineraryVersion: 'ItineraryVersion',
  ItineraryItem: 'ItineraryItem',
  ImportBatch: 'ImportBatch',
  ImportError: 'ImportError',
  MlModel: 'MlModel',
  AbAllocation: 'AbAllocation',
  NotificationTemplate: 'NotificationTemplate',
  Notification: 'Notification',
  OutboxMessage: 'OutboxMessage',
  UserNotificationSetting: 'UserNotificationSetting',
  IdempotencyKey: 'IdempotencyKey'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        let message
        const runtime = getRuntime()
        if (runtime.isEdge) {
          message = `PrismaClient is not configured to run in ${runtime.prettyName}. In order to run Prisma Client on edge runtime, either:
- Use Prisma Accelerate: https://pris.ly/d/accelerate
- Use Driver Adapters: https://pris.ly/d/driver-adapters
`;
        } else {
          message = 'PrismaClient is unable to run in this browser environment, or has been bundled for the browser (running in `' + runtime.prettyName + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
