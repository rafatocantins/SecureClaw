/**
 * llm-classifier.ts — LLM-based injection classifier interface.
 *
 * This is the second layer of injection defense (after heuristic scanning).
 * It calls a cheap/fast model to classify external content before it reaches
 * the main agent. The classifier is ONLY called for external content (DATA),
 * not for user instructions (already authenticated) or system content.
 *
 * The LLMClassifierAdapter interface is implemented by the agent-runtime's
 * provider abstraction, allowing the classifier to use any supported LLM.
 */
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
  parseClassifierResponse,
  type ClassificationResult,
} from "./classifier.prompts.js";

export type { ClassificationResult };

export interface LLMClassifierAdapter {
  /**
   * Complete a simple (non-streaming) LLM call for classification.
   * Should use the cheapest/fastest available model.
   */
  complete(systemPrompt: string, userMessage: string, maxTokens: number): Promise<string>;
}

export interface ClassifyOptions {
  /** Whether to skip the LLM classifier (use only heuristic) */
  skip_llm?: boolean;
  /** Confidence threshold above which content is flagged */
  threshold?: number;
}

/**
 * Classify external content for potential prompt injection.
 *
 * @param content - The external content to classify
 * @param classifier - LLM adapter for calling the classifier model
 * @param options - Classification options
 * @returns Classification result
 */
export async function classifyExternalContent(
  content: string,
  classifier: LLMClassifierAdapter,
  options: ClassifyOptions = {}
): Promise<ClassificationResult> {
  const { skip_llm = false } = options;

  if (skip_llm || content.trim().length === 0) {
    return {
      is_safe: true,
      contains_instructions: false,
      injection_confidence: 0.0,
      reasoning: "Skipped or empty content",
    };
  }

  try {
    const userPrompt = buildClassifierUserPrompt(content);
    const response = await classifier.complete(
      CLASSIFIER_SYSTEM_PROMPT,
      userPrompt,
      256 // Keep classifier responses short
    );
    return parseClassifierResponse(response);
  } catch (err) {
    // If classifier fails, fail closed (assume suspicious)
    return {
      is_safe: false,
      contains_instructions: false,
      injection_confidence: 0.5,
      reasoning: `Classifier error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
