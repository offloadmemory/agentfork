// Env
export { env } from './env';

// Logging
export { createLogger } from './logging/logger';

// Utils
export { withTimeout, TimeoutError } from './utils/with-timeout';

// PII redaction (irreversible placeholders, for persisted/displayed observability data)
export {
  redactText,
  redactDeep,
  DEFAULT_PII_RULES,
  SAUDE_RULES,
  REDACTED_PLACEHOLDER,
  TRUNCATED_PLACEHOLDER,
  NodeTraceCollector,
  sanitizeExecutionEvent,
  sanitizeTraceEntry,
  truncateValue,
} from './pii';
export type {
  PiiRule,
  PiiCategory,
  CustomPiiPattern,
  RedactOptions,
  NodeTraceLike,
  PersistedNodeTrace,
  PersistedTraceOutput,
  TraceEvent,
} from './pii';

// Database
export { getPrismaClient, disconnectPrisma } from './db/prisma-client';
export { getTenantClient, TENANT_SCOPED_MODELS } from './db/tenant-middleware';
export { createAuditLogRepository } from './db/repositories/repository-factory';
export type { AuditLogRepository, AuditLogRecord, CreateAuditLogInput, AuditLogFilters } from './db/repositories/audit-log/interface';
export type { PaginationParams, PaginatedResult, MessageRole, AuditSeverity, InvitationStatus } from './types/domain';

// Auth
export { getAuthSession, getSessionTenantId, getSessionUserId, assertSuperAdmin } from './auth/auth-session';
export { createAuthOptions } from './auth/auth-options';
export { getCognitoClient, COGNITO_USER_POOL_ID } from './auth/cognito-client';
import './auth/auth-types';

// RBAC
export { authorize, isAdmin, can, cannot } from './rbac/authorize';
export { hasPermission, hasCustomPermission, canAssignRole, getAutoLevel, ROLE_PERMISSIONS, ROLE_LEVELS } from './rbac/permissions';
export { SUBJECT_TO_MODULE, ACTION_MAP } from './rbac/types';
export type { Module, Action, PredefinedRole, RoleLevel, PermissionSet } from './rbac/types';
export {
  createCustomRole,
  getCustomRoles,
  getCustomRole,
  updateCustomRole,
  deleteCustomRole,
  getCustomRolePermissions,
} from './rbac/custom-role-service';
export type { CustomRoleInput, CustomRoleOutput } from './rbac/custom-role-service';

// Services
export { AuditService } from './services/audit-service';
export { TenantConfigService } from './services/tenant-config-service';
export { InvitationService } from './services/invitation-service';
export { LlmProviderService, firstChatCapableModel } from './services/llm-provider-service';
export type { LlmProviderResponse, LlmProviderEndpoints } from './services/llm-provider-service';
export { getEmailService, setEmailService } from './services/email-service';
export { ApiKeyService } from './services/api-key-service';
export { StudioService, MAX_STUDIO_ACCOUNTS_PER_USER } from './services/studio-service';
export type {
  UserStudioSummary,
  CreateStudioAccountInput,
  CreateStudioAccountResult,
} from './services/studio-service';
export type { ProvisionResult, StudioSummary, ResetPasswordResult, StudioAuthResult } from './services/studio-service';
export { QuotaService } from './services/quota-service';
export { ResponseCacheService } from './services/response-cache-service';
export {
  SemanticCacheService,
  buildScopeKey,
  sanitiseThreshold,
  getThresholdBand,
  getPresetThreshold,
  presetForThreshold,
  THRESHOLD_PRESETS,
  negationMatch,
  WIDEST_THRESHOLD_MIN,
  WIDEST_THRESHOLD_MAX,
} from './services/semantic-cache-service';
export type {
  SemanticHit,
  LookupParams,
  StoreParams,
  ThresholdBand,
  ThresholdPreset,
} from './services/semantic-cache-service';
export {
  resolveCachingConfig,
  CACHE_OVERRIDE_LABELS,
  DEFAULT_CACHE_TTL_SECONDS,
  MAX_CACHE_TTL_SECONDS,
} from './services/caching-config';
export type { ResolvedCaching, ExactCacheOverrides, SemanticCacheOverrides } from './services/caching-config';
export { computeCacheEligibility } from './services/cache-eligibility';
export type { EligibilityInput, EligibilityResult } from './services/cache-eligibility';
export { InferenceSessionService } from './services/inference-session-service';
export { WebhookService } from './services/webhook-service';
export { PausedExecutionService } from './services/paused-execution-service';
export {
  TelegramAccountBindingService,
  TelegramAccountBindingError,
} from './services/telegram-account-binding-service';
export type {
  TelegramAccountBindingDb,
  TelegramAccountBindingErrorCode,
  SyncTelegramAccountBindingInput,
} from './services/telegram-account-binding-service';
export type { PausedExecutionRow, CreatePausedExecutionInput } from './services/paused-execution-service';
// S3Service is NOT re-exported here — it pulls in @smithy/node-http-handler, which does
// static `node:http`/`node:https`/`node:http2` imports that break the browser webpack build.
// Import it from '@chatbot/shared/server' instead. See src/server.ts for the full story.
export { resolveTenantFolder } from './services/tenant-folder';
export { EncryptionService } from './services/encryption-service';
export { TranscriptionModelService } from './services/transcription-model-service';
export type {
  TranscriptionModelResponse,
  TranscriptionModelConfig,
  TranscriptionDiscoverFn,
  DiscoveredTranscriptionModel,
} from './services/transcription-model-service';
export { TranscriptionModelVersionService } from './services/transcription-model-version-service';
export type { TranscriptionModelVersionResponse } from './services/transcription-model-version-service';
export { TranscriptionJobConfigService } from './services/transcription-job-config-service';
export type {
  CreateTranscriptionJobConfigInput,
  UpdateTranscriptionJobConfigInput,
} from './services/transcription-job-config-service';
export { TranscriptionJobVersionService } from './services/transcription-job-version-service';
export { TranscriptionApiKeyService } from './services/transcription-api-key-service';
export type {
  CreateTranscriptionApiKeyInput,
  QuotaCheckResult as TranscriptionQuotaCheckResult,
} from './services/transcription-api-key-service';
export { TranscriptionJobService } from './services/transcription-job-service';
export type {
  CreateTranscriptionJobInput,
  CompleteTranscriptionJobInput,
} from './services/transcription-job-service';
// executeTranscription, TranscriptionUploadService, and dispatchUploadedTranscription are NOT
// re-exported here — each imports S3Service directly (see ../services/s3-service.ts), which
// pulls in @smithy/node-http-handler the same way S3Service itself used to when it lived in
// this barrel. Import them from '@chatbot/shared/server' instead. See src/server.ts.
export { SdkWidgetService } from './services/sdk-widget-service';
export type { CreateSdkWidgetInput, SdkWidgetDb } from './services/sdk-widget-service';
export { AgentWorkflowService } from './services/agent-workflow-service';
export type { AgentWorkflowDb } from './services/agent-workflow-service';
export { FeedbackService } from './services/feedback-service';
export type { SubmitFeedbackInput } from './services/feedback-service';
export { CsatService } from './services/csat-service';
export type { SubmitCsatInput } from './services/csat-service';
export { ScoreConfigService } from './services/score-config-service';
export type { CreateScoreConfigInput, UpdateScoreConfigInput, ScoreDataType, ScoreCategory, ScoreConfigDb } from './services/score-config-service';
export { ScoreService } from './services/score-service';
export type { CreateManualScoreInput, IngestScoreInput, ScoreFilters, ScoreTargetType, ScoreValue, ScoreDb } from './services/score-service';
export { DatasetService } from './services/dataset-service';
export type { CreateDatasetInput, UpdateDatasetInput, DatasetDb } from './services/dataset-service';
export { DatasetItemService } from './services/dataset-item-service';
export type { CreateDatasetItemInput, UpdateDatasetItemInput, AddFromTraceInput, DatasetItemDb } from './services/dataset-item-service';
export { EvaluatorService } from './services/evaluator-service';
export type { CreateEvaluatorInput, UpdateEvaluatorInput, EvaluatorDb } from './services/evaluator-service';
export { AnnotationQueueService } from './services/annotation-queue-service';
export type { CreateAnnotationQueueInput, UpdateAnnotationQueueInput, AnnotationQueueDb } from './services/annotation-queue-service';
export { AnnotationQueueItemService } from './services/annotation-queue-item-service';
export type { ReviewQueueItemInput, AnnotationQueueItemDb } from './services/annotation-queue-item-service';
export { ExperimentService } from './services/experiment-service';
export type { CreateExperimentInput, UpdateExperimentInput, ExperimentDb } from './services/experiment-service';
export { exportDatasetItems } from './services/dataset-export';
export type { DatasetExportFormat, ExportableItem, ExportResult } from './services/dataset-export';
// SES email service available for future use when @aws-sdk/client-ses is installed:
// export { SESEmailService } from './services/ses-email-service';

// Validation
export * from './validation';

// Dashboards
export * from './dashboards';
export { DashboardQueryService, TOP_N } from './services/dashboard-query-service';
export type { DashboardQueryDb, QueryResultRow } from './services/dashboard-query-service';
export { DashboardService } from './services/dashboard-service';
export type { DashboardDb } from './services/dashboard-service';

// Workflow
export {
  workflowDefinitionSchema,
  workflowNodeSchema,
  workflowTransitionSchema,
  workflowCursorSchema,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowTransition,
  type WorkflowCursor,
  type MenuOption,
} from './workflow/workflow-types';

export {
  WorkflowEngine,
  type FileRefResolver,
  type WorkflowStreamEvent,
  type ResolveResult,
} from './workflow/workflow-engine';

export {
  graphToDefinition,
  definitionToGraph,
  validateGraph,
} from './workflow/workflow-graph';
export type { GraphNode, GraphEdge, GraphError } from './workflow/workflow-types';
