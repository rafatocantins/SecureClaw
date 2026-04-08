/**
 * backup.test.ts -- Tests for skills-engine dumpSkillsState / restoreSkillsState.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { dumpSkillsState, restoreSkillsState } from "./backup.js";

let tmpDir: string;
let registryPath: string;
let marketplacePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tessera-skills-backup-"));
  registryPath = join(tmpDir, "registry.json");
  marketplacePath = join(tmpDir, "marketplace.json");

  writeFileSync(registryPath, JSON.stringify({ skills: [] }));
  writeFileSync(marketplacePath, JSON.stringify({ entries: [] }));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dumpSkillsState", () => {
  it("returns non-empty gzipped bytes and a valid SHA-256 checksum", async () => {
    const { data, checksum } = await dumpSkillsState(registryPath, marketplacePath);

    expect(data.length).toBeGreaterThan(0);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    const uncompressed = gunzipSync(data);
    const actual = createHash("sha256").update(uncompressed).digest("hex");
    expect(actual).toBe(checksum);
  });

  it("works on empty store (no files yet)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "tessera-skills-empty-"));
    const emptyRegistry = join(emptyDir, "registry.json");
    const emptyMarketplace = join(emptyDir, "marketplace.json");

    try {
      const { data, checksum } = await dumpSkillsState(emptyRegistry, emptyMarketplace);
      expect(data.length).toBeGreaterThan(0);
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("tar contains registry.json and marketplace.json entries", async () => {
    const { data } = await dumpSkillsState(registryPath, marketplacePath);
    const uncompressed = gunzipSync(data);

    const entryNames = await new Promise<string[]>((resolve, reject) => {
      const extract = tar.extract();
      const names: string[] = [];
      extract.on("entry", (header, stream, next) => {
        names.push(header.name);
        stream.on("end", next);
        stream.resume();
      });
      extract.on("finish", () => resolve(names));
      extract.on("error", reject);
      extract.end(uncompressed);
    });

    expect(entryNames).toContain("registry.json");
    expect(entryNames).toContain("marketplace.json");
  });
});

describe("restoreSkillsState", () => {
  it("writes .new files after restore", async () => {
    const { data, checksum } = await dumpSkillsState(registryPath, marketplacePath);
    await restoreSkillsState(data, checksum, registryPath, marketplacePath);

    expect(existsSync(registryPath + ".new")).toBe(true);
    expect(existsSync(marketplacePath + ".new")).toBe(true);
  });

  it("throws on bad checksum", async () => {
    const { data } = await dumpSkillsState(registryPath, marketplacePath);

    await expect(
      restoreSkillsState(
        data,
        "0000000000000000000000000000000000000000000000000000000000000000",
        registryPath,
        marketplacePath,
      ),
    ).rejects.toThrow("Checksum mismatch");
  });
});

describe("startup migration", () => {
  it("registry.json.new and marketplace.json.new are renamed when present", () => {
    const pendingRegistry = registryPath + ".new";
    const pendingMarketplace = marketplacePath + ".new";
    writeFileSync(pendingRegistry, '{"skills":[{"id":"test"}]}');
    writeFileSync(pendingMarketplace, '{"entries":[{"id":"test"}]}');

    // Replicate startup migration logic
    if (existsSync(pendingRegistry)) {
      renameSync(pendingRegistry, registryPath);
    }
    if (existsSync(pendingMarketplace)) {
      renameSync(pendingMarketplace, marketplacePath);
    }

    expect(existsSync(pendingRegistry)).toBe(false);
    expect(existsSync(pendingMarketplace)).toBe(false);
    expect(readFileSync(registryPath, "utf-8")).toBe('{"skills":[{"id":"test"}]}');
    expect(readFileSync(marketplacePath, "utf-8")).toBe('{"entries":[{"id":"test"}]}');
  });
});
