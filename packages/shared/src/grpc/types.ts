/**
 * types.ts — TypeScript interfaces for all gRPC wire types.
 *
 * These mirror the .proto message definitions.
 * Kept in sync manually — one source of truth is the .proto files.
 */

// ── Agent Service ─────────────────────────────────────────────────────────

export interface GrpcCreateSessionRequest {
  user_id: string;
  provider: string;
  metadata: Record<string, string>;
}

export interface GrpcCreateSessionResponse {
  session_id: string;
  success: boolean;
  error_message: string;
}

export interface GrpcSendMessageRequest {
  session_id: string;
  content: string;
  content_type: string;
}

// AgentChunk is a oneof — exactly one field will be set
export interface GrpcAgentChunk {
  text?: GrpcTextChunk | undefined;
  tool_pending?: GrpcToolCallPendingChunk | undefined;
  tool_result?: GrpcToolCallResultChunk | undefined;
  injection_warning?: GrpcInjectionWarningChunk | undefined;
  complete?: GrpcSessionCompleteChunk | undefined;
  error?: GrpcErrorChunk | undefined;
}

export interface GrpcTextChunk {
  delta: string;
  is_final: boolean;
}

export interface GrpcToolCallPendingChunk {
  call_id: string;
  tool_id: string;
  input_preview: string;
  requires_approval: boolean;
  approval_timeout_seconds: number;
}

export interface GrpcToolCallResultChunk {
  call_id: string;
  tool_id: string;
  success: boolean;
  duration_ms: number;
  error_message: string;
}

export interface GrpcInjectionWarningChunk {
  excerpt: string;
  pattern_matched: string;
}

export interface GrpcSessionCompleteChunk {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_calls_executed: number;
}

export interface GrpcErrorChunk {
  code: string;
  message: string;
}

export interface GrpcApproveToolCallRequest {
  session_id: string;
  call_id: string;
  approved: boolean;
}

export interface GrpcApproveToolCallResponse {
  success: boolean;
  error_message: string;
}

export interface GrpcTerminateSessionRequest {
  session_id: string;
}

export interface GrpcTerminateSessionResponse {
  success: boolean;
  total_cost_usd: number;
}

export interface GrpcGetSessionStatusRequest {
  session_id: string;
}

export interface GrpcGetSessionStatusResponse {
  session_id: string;
  status: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  tool_call_count: number;
}

// ── Vault Service ─────────────────────────────────────────────────────────

export interface GrpcSetSecretRequest {
  service: string;
  account: string;
  value: string;
}

export interface GrpcSetSecretResponse {
  ref_id: string;
  success: boolean;
  error_message: string;
}

export interface GrpcGetSecretRefRequest {
  service: string;
  account: string;
}

export interface GrpcGetSecretRefResponse {
  ref_id: string;
  exists: boolean;
}

export interface GrpcDeleteSecretRequest {
  service: string;
  account: string;
}

export interface GrpcDeleteSecretResponse {
  success: boolean;
}

export interface GrpcListSecretRefsRequest {}

export interface GrpcListSecretRefsResponse {
  refs: GrpcSecretRef[];
}

export interface GrpcSecretRef {
  ref_id: string;
  service: string;
  account: string;
  created_at: string;
}

export interface GrpcInjectCredentialRequest {
  ref_id: string;
  tool_input_json: string;
  placeholder_key: string;
}

export interface GrpcInjectCredentialResponse {
  mutated_input_json: string;
  success: boolean;
  error_message: string;
}

export interface GrpcScanRequest {
  path: string;
}

export interface GrpcScanResponse {
  warnings: string[];
  errors: string[];
}

export interface GrpcRotateKeyRequest {
  old_master_key: string;
  new_master_key: string;
}

export interface GrpcRotateKeyResponse {
  success: boolean;
  rotated_count: number;
  error_message: string;
}

// ── Audit Service ─────────────────────────────────────────────────────────

export interface GrpcLogEventRequest {
  event_type: string;
  session_id: string;
  user_id: string;
  payload_json: string;
  severity: string;
}

export interface GrpcLogEventResponse {
  event_id: number;
  success: boolean;
}

export interface GrpcQueryEventsRequest {
  session_id: string;
  from_unix_ms: number;
  to_unix_ms: number;
  event_types: string[];
  limit: number;
}

export interface GrpcAuditEvent {
  id: number;
  event_type: string;
  session_id: string;
  user_id: string;
  payload_json: string;
  severity: string;
  created_at_unix_ms: number;
}

export interface GrpcGetAlertsRequest {
  include_acknowledged: boolean;
  session_id: string;
}

export interface GrpcGetAlertsResponse {
  alerts: GrpcAlert[];
}

export interface GrpcAlert {
  id: number;
  rule_id: string;
  severity: string;
  session_id: string;
  message: string;
  context_json: string;
  created_at_unix_ms: number;
  acknowledged: boolean;
}

export interface GrpcAcknowledgeAlertRequest {
  alert_id: number;
}

export interface GrpcAcknowledgeAlertResponse {
  success: boolean;
}

export interface GrpcGetCostSummaryRequest {
  user_id: string;
  day_unix_ms: number;
}

export interface GrpcGetCostSummaryResponse {
  total_cost_usd: number;
  cap_usd: number;
  remaining_usd: number;
  cap_exceeded: boolean;
  cost_by_model: Record<string, number>;
}

export interface GrpcRecordCostRequest {
  session_id: string;
  user_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface GrpcRecordCostResponse {
  success: boolean;
}

// EU AI Act compliance report
export interface GrpcGetComplianceReportRequest {
  from_unix_ms: number;
  to_unix_ms: number;
}

export interface GrpcArticleStatus {
  article_id: string;
  status: string;
  summary: string;
  evidence_json: string;
}

export interface GrpcComplianceReportResponse {
  generated_at_iso: string;
  framework_version: string;
  overall_status: string;
  articles: GrpcArticleStatus[];
  issues: string[];
}

// Team cost summary
export interface GrpcGetTeamCostSummaryRequest {
  team_id: string;
  from_unix_ms: number;
  to_unix_ms: number;
}

export interface GrpcTeamCostEntry {
  team_id: string;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  session_count: number;
  cost_by_model: Record<string, number>;
}

export interface GrpcGetTeamCostSummaryResponse {
  teams: GrpcTeamCostEntry[];
  grand_total_usd: number;
}

// Team quotas
export interface GrpcGetTeamQuotaRequest {
  team_id: string;
}

export interface GrpcGetTeamQuotaResponse {
  quota_usd: number;
  current_spend_usd: number;
  remaining_usd: number;
  days_until_reset: number;
  at_capacity: boolean;
}

export interface GrpcSetTeamQuotaRequest {
  team_id: string;
  quota_usd: number;
}

export interface GrpcSetTeamQuotaResponse {
  success: boolean;
}

export interface GrpcCheckQuotaExceededRequest {
  team_id: string;
}

export interface GrpcCheckQuotaExceededResponse {
  exceeded: boolean;
  spent_usd: number;
  quota_usd: number;
}

// ── Sandbox Service ───────────────────────────────────────────────────────

export interface GrpcCheckRuntimeRequest {}

export interface GrpcCheckRuntimeResponse {
  gvisor_available: boolean;
  runtime_name: string;
  docker_version: string;
  ready: boolean;
  error_message: string;
}

export interface GrpcResourceLimits {
  memory_bytes: number;
  cpu_shares: number;
  pids_limit: number;
}

export interface GrpcRunToolRequest {
  call_id: string;
  tool_id: string;
  image: string;
  input_json: string;
  timeout_seconds: number;
  limits: GrpcResourceLimits;
  env_vars: string[];
  network_mode: string;
  allowed_domains: string[];
  /** Named Docker volume mounted at /workspace in the container (persists per session). */
  workspace_volume?: string;
}

export interface GrpcRunToolResponse {
  container_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  oom_killed: boolean;
}

export interface GrpcStopContainerRequest {
  container_id: string;
  timeout_seconds: number;
}

export interface GrpcStopContainerResponse {
  success: boolean;
}

// ── Skills Service ────────────────────────────────────────────────────────

export interface GrpcInstallSkillRequest {
  manifest_json: string;
  force: boolean;
}

export interface GrpcInstallSkillResponse {
  success: boolean;
  message: string;
  skill_id: string;
  skill_version: string;
  tools_registered: number;
}

export interface GrpcListSkillsRequest {
  namespace_filter: string;
  tag_filter: string;
}

export interface GrpcSkillSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  author_name: string;
  published_at: string;
  tags: string[];
  tool_count: number;
  installed_at: string;
}

export interface GrpcListSkillsResponse {
  skills: GrpcSkillSummary[];
}

export interface GrpcGetSkillRequest {
  skill_id: string;
  version: string;
}

export interface GrpcGetSkillResponse {
  found: boolean;
  manifest_json: string;
  installed_at: string;
}

export interface GrpcRemoveSkillRequest {
  skill_id: string;
  version: string;
}

export interface GrpcRemoveSkillResponse {
  success: boolean;
  message: string;
  versions_removed: number;
}

export interface GrpcExecuteSkillToolRequest {
  skill_id: string;
  skill_version: string;
  tool_id: string;
  input_json: string;
  call_id: string;
  session_id: string;
}

export interface GrpcExecuteSkillToolResponse {
  call_id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  oom_killed: boolean;
}

// Marketplace types
export interface GrpcPublishSkillRequest {
  manifest_json: string;
  trivy_scan_passed: boolean;
}

export interface GrpcPublishSkillResponse {
  success: boolean;
  skill_id: string;
  version: string;
  message: string;
}

export interface GrpcListMarketplaceSkillsRequest {
  namespace: string;
  tag: string;
  search: string;
}

export interface GrpcMarketplaceSkillSummary {
  skill_id: string;
  version: string;
  name: string;
  description: string;
  author_name: string;
  download_count: number;
  trivy_scan_passed: boolean;
  tags: string[];
}

export interface GrpcListMarketplaceSkillsResponse {
  skills: GrpcMarketplaceSkillSummary[];
}

export interface GrpcGetMarketplaceSkillRequest {
  skill_id: string;
  version: string;
}

export interface GrpcGetMarketplaceSkillResponse {
  found: boolean;
  manifest_json: string;
  download_count: number;
}

export interface GrpcInstallFromMarketplaceRequest {
  skill_id: string;
  version: string;
}

// ── Memory Service ────────────────────────────────────────────────────────

export interface GrpcStoreSessionRequest {
  session_id: string;
  user_id: string;
  provider: string;
  created_at: number;
}

export interface GrpcStoreSessionResponse {
  success: boolean;
}

export interface GrpcAppendMessageRequest {
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  tool_calls_json: string;
  tool_call_id: string;
  tool_name: string;
  created_at: number;
}

export interface GrpcAppendMessageResponse {
  message_id: number;
  success: boolean;
}

export interface GrpcFinalizeSessionRequest {
  session_id: string;
  ended_at: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_call_count: number;
}

export interface GrpcFinalizeSessionResponse {
  success: boolean;
}

export interface GrpcStoredMessage {
  id: number;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  tool_calls_json: string;
  tool_call_id: string;
  tool_name: string;
  created_at: number;
}

export interface GrpcGetRecentMessagesRequest {
  user_id: string;
  limit: number;
}

export interface GrpcGetRecentMessagesResponse {
  messages: GrpcStoredMessage[];
}

export interface GrpcSearchMessagesRequest {
  user_id: string;
  query: string;
  limit: number;
}

export interface GrpcDeleteUserDataRequest {
  user_id: string;
}

export interface GrpcDeleteUserDataResponse {
  deleted_count: number;
  success: boolean;
}

// Lessons
export interface GrpcLessonInput {
  lesson_text: string;
  category: string;
}

export interface GrpcStoredLesson {
  id: number;
  user_id: string;
  source_session_id: string;
  lesson_text: string;
  category: string;
  created_at: number;
  access_count: number;
}

export interface GrpcStoreLessonsRequest {
  source_session_id: string;
  user_id: string;
  lessons: GrpcLessonInput[];
}

export interface GrpcStoreLessonsResponse {
  stored_count: number;
  success: boolean;
}

export interface GrpcGetRelevantLessonsRequest {
  user_id: string;
  query: string;
  limit: number;
}

export interface GrpcGetRelevantLessonsResponse {
  lessons: GrpcStoredLesson[];
}

export interface GrpcListLessonsRequest {
  user_id: string;
  limit: number;
}

export interface GrpcListLessonsResponse {
  lessons: GrpcStoredLesson[];
}

// ── Harness Patches ──────────────────────────────────────────────────────

export interface GrpcStoreHarnessPatchRequest {
  id: string;
  patch_type: string;
  target: string;
  proposed_change: string;
  confidence: number;
  recommendation: string;
  source_patterns: string;
  applied: boolean;
  applied_at: number;
  generated_at: number;
}

export interface GrpcStoreHarnessPatchResponse {
  success: boolean;
}

export interface GrpcHarnessPatchEntry {
  id: string;
  patch_type: string;
  target: string;
  proposed_change: string;
  confidence: number;
  recommendation: string;
  source_patterns: string;
  applied: boolean;
  applied_at: number;
  generated_at: number;
}

export interface GrpcGetActivePatchesRequest {
  user_id: string;
  limit: number;
}

export interface GrpcGetActivePatchesResponse {
  patches: GrpcHarnessPatchEntry[];
}

}

// ── Control UI — agent runtime extensions ──────────────────────────────────

export interface GrpcListSessionsRequest {}

export interface GrpcSessionSummary {
  session_id: string;
  user_id: string;
  provider: string;
  status: string;
  created_at: number;
  last_activity_at: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  tool_call_count: number;
}

export interface GrpcListSessionsResponse {
  sessions: GrpcSessionSummary[];
}

export interface GrpcListPendingApprovalsRequest {}

export interface GrpcPendingApprovalSummary {
  call_id: string;
  session_id: string;
  user_id: string;
  tool_id: string;
  input_preview: string;
  requested_at: number;
  expires_at: number;
}

export interface GrpcListPendingApprovalsResponse {
  approvals: GrpcPendingApprovalSummary[];
}

// ── Backup / Restore (shared across all services) ────────────────────────

export interface GrpcDumpStateRequest {}

export interface GrpcDumpStateResponse {
  data: Buffer;
  checksum_sha256: string;
  success: boolean;
  error_message: string;
}

export interface GrpcRestoreStateRequest {
  data: Buffer;
  checksum_sha256: string;
}

export interface GrpcRestoreStateResponse {
  success: boolean;
  error_message: string;
  restart_required: boolean;
}
