/**
 * lesson-extractor.ts — Extracts structured lessons from a completed session transcript.
 *
 * Called at session end (when memory is enabled) to populate the lessons store.
 * Uses the same LLM provider that ran the session — never throws.
 *
 * SECURITY: stripVaultRefs() is applied before the transcript reaches the LLM.
 */
import { stripVaultRefs } from "@tessera/alerting";
import type { LLMProvider, LLMMessage } from "../llm/provider.interface.js";

export type LessonCategory = "mistake" | "preference" | "procedure" | "fact";

export interface ExtractedLesson {
  lesson_text: string;
  category: LessonCategory;
}

const VALID_CATEGORIES = new Set<string>(["mistake", "preference", "procedure", "fact"]);

const EXTRACTION_SYSTEM_PROMPT = `You are a reflection agent. Your only job is to analyze a conversation transcript and extract concise, reusable lessons for future sessions.

Return exactly this JSON (no other text):
{ "lessons": [ { "lesson_text": "...", "category": "mistake|preference|procedure|fact" } ] }

Category definitions:
- mistake: an error or wrong approach that should be avoided next time
- preference: a user preference expressed or inferred from the conversation
- procedure: a correct approach or sequence of steps that worked well
- fact: a factual constraint or discovery relevant to future work

Rules:
- Extract at most 5 lessons
- Each lesson_text must be ≤150 characters, self-contained, and actionable
- Skip trivial or obvious observations
- If there is nothing worth extracting, return { "lessons": [] }`;

/** Maximum transcript length sent to the LLM (chars) */
const MAX_TRANSCRIPT_CHARS = 8_000;

export class LessonExtractor {
  constructor(private readonly provider: LLMProvider) {}

  /**
   * Analyze a session transcript and return extracted lessons.
   * Always resolves — returns [] on any error.
   */
  async extract(messages: LLMMessage[]): Promise<ExtractedLesson[]> {
    if (messages.length === 0) return [];

    const transcript = messages
      .map((m) => {
        const role = m.role.toUpperCase();
        // Strip vault refs before sending to LLM; cap per-message content
        const raw = stripVaultRefs(m.content ?? "").slice(0, 500);
        if (!raw) return null;
        return `[${role}] ${raw}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n")
      .slice(0, MAX_TRANSCRIPT_CHARS);

    if (transcript.trim().length === 0) return [];

    const extractionMessages: LLMMessage[] = [
      {
        role: "user",
        content: `<transcript>\n${transcript}\n</transcript>`,
      },
    ];

    try {
      let fullResponse = "";
      for await (const chunk of this.provider.streamCompletion(
        extractionMessages,
        [],
        EXTRACTION_SYSTEM_PROMPT
      )) {
        if (chunk.type === "text") {
          fullResponse += chunk.text;
        } else if (chunk.type === "finish" || chunk.type === "error") {
          break;
        }
      }

      // Extract JSON object from the response
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch || !jsonMatch[0]) return [];

      const parsed = JSON.parse(jsonMatch[0]) as { lessons?: unknown };
      if (!Array.isArray(parsed.lessons)) return [];

      const results: ExtractedLesson[] = [];
      for (const item of parsed.lessons) {
        if (
          typeof item !== "object" ||
          item === null ||
          typeof (item as Record<string, unknown>)["lesson_text"] !== "string" ||
          typeof (item as Record<string, unknown>)["category"] !== "string"
        ) {
          continue;
        }
        const raw = item as { lesson_text: string; category: string };
        if (!VALID_CATEGORIES.has(raw.category)) continue;
        const lesson_text = raw.lesson_text.trim().slice(0, 150);
        if (lesson_text.length === 0) continue;
        results.push({ lesson_text, category: raw.category as LessonCategory });
        if (results.length >= 5) break;
      }
      return results;
    } catch {
      // Never surface extraction errors to the caller — lessons are best-effort
      return [];
    }
  }
}
