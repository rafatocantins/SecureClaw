/**
 * types.ts — Type definitions for the Verifier Gate.
 *
 * Pure TypeScript — no Docker, no Integration Tests, no Node 22 CI.
 * Part of ADR-007: Thinker → Worker → Verifier pipeline.
 */

export interface VerificationResult {
  passed: boolean;
  score: number; // 0-100
  checks: VerificationCheck[];
  summary: string;
}

export interface VerificationCheck {
  category: 'factuality' | 'completeness' | 'safety' | 'compliance';
  passed: boolean;
  detail: string;
}

export interface VerificationInput {
  taskDescription: string;
  agentOutput: string;
  expectedFormat?: string;
  safetyContext?: 'sandbox' | 'api' | 'user-facing';
}
