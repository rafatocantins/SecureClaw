/**
 * audit-service.adapter.ts — Adapts the AuditGrpcClient to the harness-evolution
 * `AuditService` interface.
 *
 * The harness self-evolution pipeline (SessionAnalyzer) depends on a small,
 * pure `AuditService` seam (getRecentSessions / getSessionEvents) so it has no
 * direct database coupling. This adapter satisfies that seam over the existing
 * AuditService gRPC `QueryEvents` RPC.
 *
 * Graceful degradation: if the audit service is unreachable, both methods
 * resolve to empty arrays so `evolve()` degrades to "0 sessions analyzed"
 * instead of crashing the agent runtime.
 */
import type { AuditGrpcClient } from "../grpc/clients/audit.client.js";
import type {
  AuditService,
  AuditSession,
  AuditEvent,
} from "./types.js";
import type { GrpcAuditEvent } from "@tessera/shared";

/** Upper bound of events pulled per session when deriving recent sessions. */
const RECENT_SESSIONS_EVENT_LIMIT = 2000;
const SESSION_EVENTS_LIMIT = 1000;

/**
 * Maps a wire-level audit event into the harness-evolution `AuditEvent` shape.
 *
 * event_type is lowercased to match the taxonomy the pattern detectors expect
 * (e.g. "TOOL_CALL" → "tool_call"). toolName / success / error are best-effort
 * extracted from the event's payload JSON; missing fields are left undefined.
 */
function toAuditEvent(ev: GrpcAuditEvent): AuditEvent {
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(ev.payload_json);
    if (parsed && typeof parsed === "object") {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    details = {};
  }

  const toolNameRaw = details["tool_name"] ?? details["toolName"];
  const toolName =
    typeof toolNameRaw === "string" ? toolNameRaw : undefined;
  const successRaw = details["success"];
  const success = typeof successRaw === "boolean" ? successRaw : undefined;
  const errorRaw = details["error"];
  const error = typeof errorRaw === "string" ? errorRaw : undefined;

  return {
    sessionId: ev.session_id,
    timestamp: new Date(ev.created_at_unix_ms),
    eventType: ev.event_type.toLowerCase(),
    ...(toolName !== undefined && { toolName }),
    ...(success !== undefined && { success }),
    ...(error !== undefined && { error }),
    details,
  };
}

export class AuditServiceAdapter implements AuditService {
  private readonly auditClient: AuditGrpcClient;

  constructor(auditClient: AuditGrpcClient) {
    this.auditClient = auditClient;
  }

  /**
   * Derives recent sessions by grouping the latest audit events by session_id.
   * modelId is not surfaced by the audit wire type, so it is left empty; status
   * defaults to "completed" (end-of-session lifecycle data is not yet exposed).
   */
  async getRecentSessions(limit: number): Promise<AuditSession[]> {
    let events: GrpcAuditEvent[];
    try {
      events = await this.auditClient.queryEvents({
        session_id: "",
        from_unix_ms: 0,
        to_unix_ms: 0,
        event_types: [],
        limit: RECENT_SESSIONS_EVENT_LIMIT,
      });
    } catch {
      return [];
    }

    const bySession = new Map<string, { startTime: Date; endTime: Date }>();
    for (const ev of events) {
      if (!ev.session_id) continue;
      const ts = new Date(ev.created_at_unix_ms);
      const entry = bySession.get(ev.session_id);
      if (entry === undefined) {
        bySession.set(ev.session_id, { startTime: ts, endTime: ts });
        continue;
      }
      if (ts.getTime() < entry.startTime.getTime()) entry.startTime = ts;
      if (ts.getTime() > entry.endTime.getTime()) entry.endTime = ts;
    }

    return Array.from(bySession.entries())
      .sort((a, b) => b[1].endTime.getTime() - a[1].endTime.getTime())
      .slice(0, limit)
      .map(([sessionId, meta]) => ({
        sessionId,
        startTime: meta.startTime,
        endTime: meta.endTime,
        modelId: "",
        status: "completed",
      }));
  }

  async getSessionEvents(sessionId: string): Promise<AuditEvent[]> {
    let events: GrpcAuditEvent[];
    try {
      events = await this.auditClient.queryEvents({
        session_id: sessionId,
        from_unix_ms: 0,
        to_unix_ms: 0,
        event_types: [],
        limit: SESSION_EVENTS_LIMIT,
      });
    } catch {
      return [];
    }
    return events.map(toAuditEvent);
  }
}
