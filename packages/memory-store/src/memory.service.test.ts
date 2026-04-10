import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db/schema.js";
import { MemoryService } from "./memory.service.js";
import type { AppendMessageParams, StoreSessionParams } from "./memory.service.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

function makeService(): { db: DatabaseSync; svc: MemoryService } {
  const db = makeDb();
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

function msg(
  svc: MemoryService,
  overrides: Partial<AppendMessageParams> & { session_id: string; user_id: string }
): number {
  return svc.appendMessage({
    role: "user",
    content: "default content",
    tool_calls_json: "",
    tool_call_id: "",
    tool_name: "",
    created_at: Date.now(),
    ...overrides,
  });
}

// ── storeSession ──────────────────────────────────────────────────────────────

describe("storeSession", () => {
  it("inserts a session row", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    const row = db.prepare("SELECT id, user_id, provider FROM sessions WHERE id = ?").get("s1") as {
      id: string;
      user_id: string;
      provider: string;
    };
    expect(row.id).toBe("s1");
    expect(row.user_id).toBe("u1");
    expect(row.provider).toBe("anthropic");
  });

  it("is idempotent — second call with same id does nothing (ON CONFLICT DO NOTHING)", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    // Second call with different provider — should be ignored
    svc.storeSession({ ...SESSION1, provider: "openai" });
    const count = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
    expect(count).toBe(1);
    const row = db.prepare("SELECT provider FROM sessions WHERE id = 's1'").get() as { provider: string };
    expect(row.provider).toBe("anthropic"); // original value preserved
  });
});

// ── appendMessage ─────────────────────────────────────────────────────────────

describe("appendMessage", () => {
  it("inserts a user message and returns its rowid", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    const id = msg(svc, { session_id: "s1", user_id: "u1", content: "hello world", created_at: 2_000 });
    expect(id).toBe(1);
  });

  it("inserts an assistant message with tool_calls_json", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, {
      session_id: "s1",
      user_id: "u1",
      role: "assistant",
      content: "calling tool",
      tool_calls_json: JSON.stringify([{ call_id: "c1", tool_id: "shell_exec", input: {} }]),
      created_at: 2_000,
    });
    const row = db.prepare("SELECT role, tool_calls_json FROM messages WHERE id = 1").get() as {
      role: string;
      tool_calls_json: string;
    };
    expect(row.role).toBe("assistant");
    expect(JSON.parse(row.tool_calls_json)).toHaveLength(1);
  });

  it("inserts a tool result message with tool_call_id and tool_name", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, {
      session_id: "s1",
      user_id: "u1",
      role: "tool",
      content: "output text",
      tool_call_id: "c1",
      tool_name: "shell_exec",
      created_at: 2_000,
    });
    const row = db.prepare("SELECT role, tool_call_id, tool_name FROM messages WHERE id = 1").get() as {
      role: string;
      tool_call_id: string;
      tool_name: string;
    };
    expect(row.role).toBe("tool");
    expect(row.tool_call_id).toBe("c1");
    expect(row.tool_name).toBe("shell_exec");
  });

  it("rejects an invalid role via CHECK constraint", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    expect(() =>
      msg(svc, { session_id: "s1", user_id: "u1", role: "system" })
    ).toThrow();
  });
});

// ── getRecentMessages ─────────────────────────────────────────────────────────

describe("getRecentMessages", () => {
  it("returns messages in chronological order (oldest first)", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, { session_id: "s1", user_id: "u1", content: "first",  created_at: 1_000 });
    msg(svc, { session_id: "s1", user_id: "u1", content: "second", created_at: 2_000 });
    msg(svc, { session_id: "s1", user_id: "u1", content: "third",  created_at: 3_000 });

    const msgs = svc.getRecentMessages("u1", 10);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe("first");
    expect(msgs[2]!.content).toBe("third");
  });

  it("respects the limit — returns the N most recent in chronological order", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    for (let i = 0; i < 10; i++) {
      msg(svc, { session_id: "s1", user_id: "u1", content: `msg${i}`, created_at: (i + 1) * 1_000 });
    }
    const msgs = svc.getRecentMessages("u1", 3);
    expect(msgs).toHaveLength(3);
    // The 3 most recent returned in chronological order
    expect(msgs[0]!.content).toBe("msg7");
    expect(msgs[2]!.content).toBe("msg9");
  });

  it("isolates messages by user_id", () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    msg(svc, { session_id: "s1", user_id: "u1", content: "u1-msg", created_at: 1_000 });
    msg(svc, { session_id: "s2", user_id: "u2", content: "u2-msg", created_at: 2_000 });

    const u1msgs = svc.getRecentMessages("u1", 10);
    expect(u1msgs).toHaveLength(1);
    expect(u1msgs[0]!.content).toBe("u1-msg");
  });

  it("returns empty array when no messages exist for user", () => {
    const { svc } = makeService();
    expect(svc.getRecentMessages("nobody", 10)).toHaveLength(0);
  });
});

// ── searchMessages (FTS5) ─────────────────────────────────────────────────────

describe("searchMessages (FTS5)", () => {
  it("finds messages containing a keyword", async () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, { session_id: "s1", user_id: "u1", content: "deploy the kubernetes cluster", created_at: 1_000 });
    msg(svc, { session_id: "s1", user_id: "u1", content: "list docker containers",        created_at: 2_000 });

    const results = await svc.searchMessages("u1", "kubernetes", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("kubernetes");
  });

  it("enforces user_id isolation in search results", async () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    msg(svc, { session_id: "s1", user_id: "u1", content: "kubernetes deployment", created_at: 1_000 });
    msg(svc, { session_id: "s2", user_id: "u2", content: "kubernetes pods",       created_at: 2_000 });

    const u1results = await svc.searchMessages("u1", "kubernetes", 10);
    expect(u1results).toHaveLength(1);
    expect(u1results[0]!.user_id).toBe("u1");
  });

  it("returns empty array when no messages match the query", async () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, { session_id: "s1", user_id: "u1", content: "unrelated content", created_at: 1_000 });

    const results = await svc.searchMessages("u1", "xyzzy_not_found", 10);
    expect(results).toHaveLength(0);
  });
});

// ── finalizeSession ───────────────────────────────────────────────────────────

describe("finalizeSession", () => {
  it("updates ended_at, token counts, cost, and tool_call_count", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    svc.finalizeSession({
      session_id: "s1",
      ended_at: 9_000,
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.0025,
      tool_call_count: 3,
    });
    const row = db
      .prepare("SELECT ended_at, input_tokens, output_tokens, cost_usd, tool_call_count FROM sessions WHERE id = 's1'")
      .get() as {
      ended_at: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      tool_call_count: number;
    };
    expect(row.ended_at).toBe(9_000);
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(200);
    expect(row.cost_usd).toBeCloseTo(0.0025);
    expect(row.tool_call_count).toBe(3);
  });
});

// ── deleteUserData (GDPR) ─────────────────────────────────────────────────────

describe("deleteUserData", () => {
  it("returns the message count and cascades deletion to messages", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, { session_id: "s1", user_id: "u1", content: "msg1", created_at: 1_000 });
    msg(svc, { session_id: "s1", user_id: "u1", content: "msg2", created_at: 2_000 });

    const deleted = svc.deleteUserData("u1");
    expect(deleted).toBe(2);

    const msgCount = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE user_id = 'u1'").get() as { c: number }).c;
    const sesCount = (db.prepare("SELECT COUNT(*) as c FROM sessions WHERE user_id = 'u1'").get() as { c: number }).c;
    expect(msgCount).toBe(0);
    expect(sesCount).toBe(0);
  });

  it("does not affect other users' data", () => {
    const { db, svc } = makeService();
    svc.storeSession(SESSION1);
    svc.storeSession(SESSION2);
    msg(svc, { session_id: "s1", user_id: "u1", content: "u1 data", created_at: 1_000 });
    msg(svc, { session_id: "s2", user_id: "u2", content: "u2 data", created_at: 1_000 });

    svc.deleteUserData("u1");

    const u2msgs = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE user_id = 'u2'").get() as { c: number }).c;
    expect(u2msgs).toBe(1);
  });

  it("returns 0 when user has no data", () => {
    const { svc } = makeService();
    expect(svc.deleteUserData("nonexistent")).toBe(0);
  });
});

// ── schema integrity ──────────────────────────────────────────────────────────

describe("schema integrity", () => {
  it("initSchema is idempotent — calling it twice does not throw", () => {
    const db = makeDb();
    expect(() => initSchema(db)).not.toThrow();
  });

  it("FTS index is cleaned up after deleteUserData — search returns no stale results", async () => {
    const { svc } = makeService();
    svc.storeSession(SESSION1);
    msg(svc, { session_id: "s1", user_id: "u1", content: "to be deleted", created_at: 1_000 });

    svc.deleteUserData("u1");

    // The FTS delete trigger must have removed the entry; no stale results
    const results = await svc.searchMessages("u1", "deleted", 10);
    expect(results).toHaveLength(0);
  });
});
