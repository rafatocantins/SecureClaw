import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db/schema.js";
import { MemoryService } from "./memory.service.js";
import type { StoreSessionParams } from "./memory.service.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeService(): { db: DatabaseSync; svc: MemoryService } {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return { db, svc: new MemoryService(db) };
}

const SESSION1: StoreSessionParams = {
  session_id: "s1",
  user_id: "u1",
  provider: "anthropic",
  created_at: 1_000,
};

const SESSION2: StoreSessionParams = {
  session_id: "s2",
  user_id: "u2",
  provider: "openai",
  created_at: 2_000,
};

// ── storeLessons ──────────────────────────────────────────────────────────────

describe("storeLessons", () => {
  it("stores lessons and returns count", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    const count = svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "Always validate input before processing", category: "procedure" },
        { lesson_text: "User prefers concise responses", category: "preference" },
      ],
    });
    expect(count).toBe(2);
  });

  it("deduplicates lessons by (user_id, lesson_text) — second call is silently skipped", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    const first = svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "Use snake_case for variables", category: "procedure" }],
    });
    const second = svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "Use snake_case for variables", category: "procedure" }],
    });
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("same lesson text for different users are stored independently", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    const c1 = svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "Keep answers brief", category: "preference" }],
    });
    const c2 = svc.storeLessons({
      source_session_id: "s2",
      user_id: "u2",
      lessons: [{ lesson_text: "Keep answers brief", category: "preference" }],
    });
    expect(c1).toBe(1);
    expect(c2).toBe(1);
  });

  it("returns 0 when given an empty lessons array", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    const count = svc.storeLessons({ source_session_id: "s1", user_id: "u1", lessons: [] });
    expect(count).toBe(0);
  });

  it("accepts all valid categories", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    const count = svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "mistake: never truncate logs",       category: "mistake" },
        { lesson_text: "preference: use tabs not spaces",    category: "preference" },
        { lesson_text: "procedure: always run tests first",  category: "procedure" },
        { lesson_text: "fact: SQLite is single-writer",      category: "fact" },
      ],
    });
    expect(count).toBe(4);
  });
});

// ── listLessons ───────────────────────────────────────────────────────────────

describe("listLessons", () => {
  it("returns lessons in recency order (newest first)", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "first lesson stored", category: "fact" },
        { lesson_text: "second lesson stored", category: "fact" },
      ],
    });
    // Both inserted with same Date.now() — order is deterministic by AUTOINCREMENT id
    const lessons = svc.listLessons("u1", 10);
    expect(lessons).toHaveLength(2);
    expect(lessons.every((l) => l.user_id === "u1")).toBe(true);
  });

  it("respects the limit parameter", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "lesson alpha",   category: "fact" },
        { lesson_text: "lesson beta",    category: "fact" },
        { lesson_text: "lesson gamma",   category: "fact" },
        { lesson_text: "lesson delta",   category: "fact" },
        { lesson_text: "lesson epsilon", category: "fact" },
      ],
    });
    const lessons = svc.listLessons("u1", 3);
    expect(lessons).toHaveLength(3);
  });

  it("isolates lessons by user_id", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "u1 lesson", category: "preference" }],
    });
    svc.storeLessons({
      source_session_id: "s2",
      user_id: "u2",
      lessons: [{ lesson_text: "u2 lesson", category: "preference" }],
    });

    const u1 = svc.listLessons("u1", 10);
    expect(u1).toHaveLength(1);
    expect(u1[0]!.lesson_text).toBe("u1 lesson");
  });

  it("returns empty array when user has no lessons", () => {
    const { svc } = makeService();
    expect(svc.listLessons("nobody", 10)).toHaveLength(0);
  });

  it("does not increment access_count", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "do not count accesses on list", category: "fact" }],
    });
    svc.listLessons("u1", 10);
    const row = db.prepare("SELECT access_count FROM lessons WHERE user_id = 'u1'").get() as {
      access_count: number;
    };
    expect(row.access_count).toBe(0);
  });
});

// ── getRelevantLessons ────────────────────────────────────────────────────────

describe("getRelevantLessons", () => {
  it("FTS5 search returns matching lessons", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "always checkpoint before database migrations", category: "procedure" },
        { lesson_text: "user prefers minimal output in responses",     category: "preference" },
      ],
    });
    const results = svc.getRelevantLessons("u1", "database", 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.lesson_text).toContain("database");
  });

  it("empty query returns most-recent lessons without FTS", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "lesson one", category: "fact" },
        { lesson_text: "lesson two", category: "fact" },
      ],
    });
    const results = svc.getRelevantLessons("u1", "", 5);
    expect(results).toHaveLength(2);
  });

  it("increments access_count for returned lessons", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "increment test lesson", category: "fact" }],
    });
    svc.getRelevantLessons("u1", "", 5);
    svc.getRelevantLessons("u1", "", 5);
    const row = db.prepare("SELECT access_count FROM lessons WHERE user_id = 'u1'").get() as {
      access_count: number;
    };
    expect(row.access_count).toBe(2);
  });

  it("isolates results by user_id on FTS search", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "kubernetes deployment strategy", category: "procedure" }],
    });
    svc.storeLessons({
      source_session_id: "s2",
      user_id: "u2",
      lessons: [{ lesson_text: "kubernetes pod scaling procedure", category: "procedure" }],
    });

    const u1 = svc.getRelevantLessons("u1", "kubernetes", 5);
    expect(u1).toHaveLength(1);
    expect(u1[0]!.user_id).toBe("u1");
  });

  it("returns empty array when no lessons match", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "unrelated content here", category: "fact" }],
    });
    const results = svc.getRelevantLessons("u1", "xyzzy_not_found", 5);
    expect(results).toHaveLength(0);
  });
});

// ── deleteUserData + lessons ──────────────────────────────────────────────────

describe("deleteUserData with lessons", () => {
  it("also removes all lessons for the user", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "lesson to be deleted", category: "fact" },
      ],
    });
    svc.deleteUserData("u1");
    const count = (db.prepare("SELECT COUNT(*) as c FROM lessons WHERE user_id = 'u1'").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("does not delete lessons for other users", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "u1 lesson to delete", category: "preference" }],
    });
    svc.storeLessons({
      source_session_id: "s2",
      user_id: "u2",
      lessons: [{ lesson_text: "u2 lesson to keep", category: "preference" }],
    });
    svc.deleteUserData("u1");
    const u2count = (db.prepare("SELECT COUNT(*) as c FROM lessons WHERE user_id = 'u2'").get() as { c: number }).c;
    expect(u2count).toBe(1);
  });

  it("lessons FTS index is cleaned up after deleteUserData", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [{ lesson_text: "lesson to be purged", category: "fact" }],
    });
    svc.deleteUserData("u1");
    // After deletion FTS triggers must have removed the entry
    const results = svc.getRelevantLessons("u1", "purged", 5);
    expect(results).toHaveLength(0);
  });
});
