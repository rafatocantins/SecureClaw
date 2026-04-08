/**
 * registry.ts — In-memory skill registry with optional JSON file persistence.
 *
 * The registry is the single source of truth for installed skills.
 * All writes go through install() or remove() which call verifySkillManifest()
 * before accepting the manifest.
 *
 * Persistence: skills are written to a JSON file on every mutation.
 * On startup, the file is loaded and each manifest is re-verified.
 * If the file is missing or corrupt, the registry starts empty.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type SkillManifest, type SkillToolDefinition } from "@tessera/shared";
import { verifySkillManifest, type SkillVerificationResult } from "./verifier.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface InstalledSkill {
  manifest: SkillManifest;
  installed_at: string; // ISO-8601
}

export interface RegistryEntry {
  /** "namespace/name@version" */
  key: string;
  skill: InstalledSkill;
}

export interface InstallResult {
  success: boolean;
  message: string;
  skill_id?: string;
  skill_version?: string;
  tools_registered?: number;
}

export interface RemoveResult {
  success: boolean;
  message: string;
  versions_removed: number;
}

// ── SkillRegistry ─────────────────────────────────────────────────────────

export class SkillRegistry {
  /** key: "namespace/name@version" → InstalledSkill */
  private readonly store = new Map<string, InstalledSkill>();

  constructor(private readonly persistPath?: string) {
    if (persistPath) {
      this.loadFromDisk(persistPath);
    }
  }

  // ── Install ─────────────────────────────────────────────────────────────

  install(manifestJson: string, force = false): InstallResult {
    // Verify before touching the registry
    const result: SkillVerificationResult = verifySkillManifest(manifestJson);
    if (!result.valid) {
      return { success: false, message: result.error ?? "Verification failed" };
    }

    const manifest = result.manifest!;
    const key = this.makeKey(manifest.id, manifest.version);

    if (this.store.has(key) && !force) {
      return {
        success: false,
        message: `Skill ${manifest.id}@${manifest.version} is already installed. Use force=true to replace.`,
      };
    }

    const entry: InstalledSkill = {
      manifest,
      installed_at: new Date().toISOString(),
    };

    this.store.set(key, entry);
    this.persist();

    return {
      success: true,
      message: `Installed ${manifest.id}@${manifest.version} with ${manifest.tools.length} tool(s).`,
      skill_id: manifest.id,
      skill_version: manifest.version,
      tools_registered: manifest.tools.length,
    };
  }

  // ── List ────────────────────────────────────────────────────────────────

  list(namespaceFilter?: string, tagFilter?: string): InstalledSkill[] {
    const skills: InstalledSkill[] = [];

    for (const skill of this.store.values()) {
      const { manifest } = skill;

      if (namespaceFilter) {
        const namespace = manifest.id.split("/")[0];
        if (namespace !== namespaceFilter) continue;
      }

      if (tagFilter) {
        if (!manifest.tags.includes(tagFilter)) continue;
      }

      skills.push(skill);
    }

    // Sort by id then version for stable output
    skills.sort((a, b) => {
      const idCmp = a.manifest.id.localeCompare(b.manifest.id);
      if (idCmp !== 0) return idCmp;
      return a.manifest.version.localeCompare(b.manifest.version);
    });

    return skills;
  }

  // ── Get ─────────────────────────────────────────────────────────────────

  get(skillId: string, version?: string): InstalledSkill | undefined {
    if (version) {
      return this.store.get(this.makeKey(skillId, version));
    }

    // Return latest version (highest semver)
    let latest: InstalledSkill | undefined;
    for (const skill of this.store.values()) {
      if (skill.manifest.id !== skillId) continue;
      if (!latest || compareSemver(skill.manifest.version, latest.manifest.version) > 0) {
        latest = skill;
      }
    }
    return latest;
  }

  // ── Remove ──────────────────────────────────────────────────────────────

  remove(skillId: string, version?: string): RemoveResult {
    let removed = 0;

    if (version) {
      const key = this.makeKey(skillId, version);
      if (this.store.delete(key)) {
        removed = 1;
      }
    } else {
      // Remove all versions
      for (const [key, skill] of this.store.entries()) {
        if (skill.manifest.id === skillId) {
          this.store.delete(key);
          removed++;
        }
      }
    }

    if (removed === 0) {
      return {
        success: false,
        message: version
          ? `Skill ${skillId}@${version} not found`
          : `No versions of ${skillId} found`,
        versions_removed: 0,
      };
    }

    this.persist();
    return {
      success: true,
      message: `Removed ${removed} version(s) of ${skillId}`,
      versions_removed: removed,
    };
  }

  // ── Tool lookup ─────────────────────────────────────────────────────────

  /**
   * Find a specific tool by skill id + version + tool_id.
   * Returns undefined if skill or tool not found.
   */
  getTool(
    skillId: string,
    skillVersion: string,
    toolId: string
  ): { skill: InstalledSkill; tool: SkillToolDefinition } | undefined {
    const skill = this.get(skillId, skillVersion);
    if (!skill) return undefined;
    const tool = skill.manifest.tools.find((t) => t.tool_id === toolId);
    if (!tool) return undefined;
    return { skill, tool };
  }

  /**
   * Returns all tools across all installed skills, suitable for injecting
   * into the agent loop's TOOL_DEFINITIONS array.
   */
  getAllToolDefinitions(): Array<{
    skill_id: string;
    skill_version: string;
    tool: SkillToolDefinition;
  }> {
    const defs: Array<{ skill_id: string; skill_version: string; tool: SkillToolDefinition }> = [];
    for (const skill of this.store.values()) {
      for (const tool of skill.manifest.tools) {
        defs.push({
          skill_id: skill.manifest.id,
          skill_version: skill.manifest.version,
          tool,
        });
      }
    }
    return defs;
  }

  size(): number {
    return this.store.size;
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private makeKey(id: string, version: string): string {
    return `${id}@${version}`;
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data: Record<string, InstalledSkill> = {};
      for (const [key, skill] of this.store.entries()) {
        data[key] = skill;
      }
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      process.stderr.write(
        `[skills-registry] Failed to persist registry to ${this.persistPath}: ${String(err)}\n`
      );
    }
  }

  private loadFromDisk(path: string): void {
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as Record<string, InstalledSkill>;

      let loaded = 0;
      let skipped = 0;
      for (const [key, entry] of Object.entries(data)) {
        // Re-verify each manifest on load — protects against file tampering
        const manifestJson = JSON.stringify(entry.manifest);
        const result = verifySkillManifest(manifestJson);
        if (!result.valid) {
          process.stderr.write(
            `[skills-registry] Skipping tampered/invalid entry ${key}: ${result.error}\n`
          );
          skipped++;
          continue;
        }
        this.store.set(key, { manifest: result.manifest!, installed_at: entry.installed_at });
        loaded++;
      }

      process.stderr.write(
        `[skills-registry] Loaded ${loaded} skill(s) from ${path}` +
          (skipped > 0 ? ` (${skipped} skipped — verification failed)` : "") +
          "\n"
      );
    } catch (err) {
      process.stderr.write(
        `[skills-registry] Could not load registry from ${path}: ${String(err)} — starting empty\n`
      );
    }
  }

  /** Return the path to the JSON registry file (for backup). */
  getRegistryPath(): string | undefined {
    return this.persistPath;
  }
}

// ── Semver comparison (major.minor.patch only) ────────────────────────────

function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split(".").map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}
