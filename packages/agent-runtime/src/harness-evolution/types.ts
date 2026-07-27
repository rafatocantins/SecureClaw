/**
 * Harness Evolution — Shared Types
 *
 * Defines the core interfaces for session analysis,
 * failure pattern detection, and harness patch generation.
 */

export interface FailurePattern {
  type: "tool_failure" | "loop_detected" | "injection_detected" | "approval_bottleneck";
  sessionId: string;
  frequency: number;
  evidence: string[];
  firstSeen: Date;
  lastSeen: Date;
}

export interface SessionAnalysis {
  sessionId: string;
  patterns: FailurePattern[];
  analyzedAt: Date;
  sessionCount: number;
}

export interface HarnessPatch {
  id: string;
  type: "prompt_update" | "tool_rule" | "system_instruction";
  target: string;
  proposedChange: string;
  rationale: string;
  confidence: number;
  sourcePatterns: FailurePattern["type"][];
  generatedAt: Date;
}

export interface ConfidenceScore {
  score: number; // 0-1
  factors: Record<string, number>;
  recommendation: "apply" | "review" | "reject";
}

export interface AuditService {
  getRecentSessions(limit: number): Promise<AuditSession[]>;
  getSessionEvents(sessionId: string): Promise<AuditEvent[]>;
}

export interface AuditSession {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  modelId: string;
  status: "completed" | "failed" | "aborted";
}

export interface AuditEvent {
  sessionId: string;
  timestamp: Date;
  eventType: string;
  toolName?: string;
  success?: boolean;
  error?: string;
  details?: Record<string, unknown>;
}
