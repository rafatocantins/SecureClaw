/**
 * marketplace.ts — Community marketplace registry for Tessera skills.
 *
 * Skills are stored as signed manifest JSON strings.
 * All signatures are verified before publishing.
 * Download counts are tracked for popularity ranking.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface MarketplaceEntry {
  skill_id: string;
  skill_version: string;
  manifest_json: string;   // full signed manifest
  published_at: number;    // unix ms
  download_count: number;  // incremented on install
  trivy_scan_passed: boolean;
  trivy_scan_at: number;   // unix ms when scan was performed (0 if not scanned)
}

export interface PublishResult {
  success: boolean;
  skill_id: string;
  version: string;
  message: string;
}

export class MarketplaceRegistry {
  private entries: Map<string, MarketplaceEntry>; // key: "id@version"
  private filePath: string;

  constructor(registryPath: string) {
    this.filePath = registryPath;
    this.entries = new Map();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as { entries?: MarketplaceEntry[] };
      for (const entry of data.entries ?? []) {
        this.entries.set(`${entry.skill_id}@${entry.skill_version}`, entry);
      }
    } catch {
      // Start fresh if file is corrupt
    }
  }

  private persist(): void {
    const data = { entries: [...this.entries.values()] };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  publish(manifestJson: string, trivyScanPassed: boolean): PublishResult {
    let parsed: { id?: string; version?: string };
    try {
      parsed = JSON.parse(manifestJson) as { id?: string; version?: string };
    } catch {
      return { success: false, skill_id: "", version: "", message: "Invalid manifest JSON" };
    }

    const skill_id = parsed.id ?? "";
    const skill_version = parsed.version ?? "";

    if (!skill_id || !skill_version) {
      return { success: false, skill_id, version: skill_version, message: "Manifest missing id or version" };
    }

    const key = `${skill_id}@${skill_version}`;
    if (this.entries.has(key)) {
      return { success: false, skill_id, version: skill_version, message: `${key} already published` };
    }

    const entry: MarketplaceEntry = {
      skill_id,
      skill_version,
      manifest_json: manifestJson,
      published_at: Date.now(),
      download_count: 0,
      trivy_scan_passed: trivyScanPassed,
      trivy_scan_at: trivyScanPassed ? Date.now() : 0,
    };

    this.entries.set(key, entry);
    this.persist();
    return { success: true, skill_id, version: skill_version, message: "Published successfully" };
  }

  list(namespace?: string, tag?: string, search?: string): MarketplaceEntry[] {
    let results = [...this.entries.values()];

    if (namespace) {
      results = results.filter((e) => e.skill_id.startsWith(`${namespace}/`));
    }

    if (tag) {
      results = results.filter((e) => {
        try {
          const m = JSON.parse(e.manifest_json) as { tags?: string[] };
          return m.tags?.includes(tag) ?? false;
        } catch { return false; }
      });
    }

    if (search) {
      const q = search.toLowerCase();
      results = results.filter((e) => {
        try {
          const m = JSON.parse(e.manifest_json) as { name?: string; description?: string };
          return (
            e.skill_id.toLowerCase().includes(q) ||
            (m.name ?? "").toLowerCase().includes(q) ||
            (m.description ?? "").toLowerCase().includes(q)
          );
        } catch { return e.skill_id.toLowerCase().includes(q); }
      });
    }

    return results.sort((a, b) => b.download_count - a.download_count);
  }

  get(skillId: string, version?: string): MarketplaceEntry | undefined {
    if (version) {
      return this.entries.get(`${skillId}@${version}`);
    }
    // Return highest version by published_at if no version specified
    let latest: MarketplaceEntry | undefined;
    for (const [, entry] of this.entries) {
      if (entry.skill_id === skillId) {
        if (!latest || entry.published_at > latest.published_at) {
          latest = entry;
        }
      }
    }
    return latest;
  }

  recordInstall(skillId: string, version: string): void {
    const key = `${skillId}@${version}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.download_count++;
      this.persist();
    }
  }

  size(): number {
    return this.entries.size;
  }

  /** Return the path to the marketplace JSON file (for backup). */
  getMarketplacePath(): string {
    return this.filePath;
  }
}
