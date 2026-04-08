/**
 * backup.ts -- DumpState / RestoreState logic for skills-engine.
 *
 * Packs registry.json + marketplace.json into a gzip-compressed tar archive.
 * On restore, writes .new files next to the originals for startup migration.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import * as tar from "tar-stream";

export interface SkillsDumpResult {
  data: Buffer;
  checksum: string;
}

/**
 * Dump both registry and marketplace JSON files into a gzip-compressed tar.
 */
export async function dumpSkillsState(
  registryPath: string | undefined,
  marketplacePath: string | undefined,
): Promise<SkillsDumpResult> {
  const registryData =
    registryPath !== undefined && existsSync(registryPath)
      ? readFileSync(registryPath)
      : Buffer.alloc(0);

  const marketplaceData =
    marketplacePath !== undefined && existsSync(marketplacePath)
      ? readFileSync(marketplacePath)
      : Buffer.alloc(0);

  const tarBuffer = await new Promise<Buffer>((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];

    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);

    pack.entry({ name: "registry.json" }, registryData);
    pack.entry({ name: "marketplace.json" }, marketplaceData);
    pack.finalize();
  });

  const checksum = createHash("sha256").update(tarBuffer).digest("hex");
  const compressed = gzipSync(tarBuffer);
  return { data: compressed, checksum };
}

/**
 * Restore skills state from a gzip-compressed tar archive.
 * Writes .new files next to the originals for startup migration.
 */
export async function restoreSkillsState(
  data: Buffer,
  checksum: string,
  registryPath: string | undefined,
  marketplacePath: string | undefined,
): Promise<void> {
  const tarBuffer = gunzipSync(data);
  const actual = createHash("sha256").update(tarBuffer).digest("hex");
  if (actual !== checksum) {
    throw new Error(`Checksum mismatch: expected ${checksum}, got ${actual}`);
  }

  const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    const extract = tar.extract();
    const entries = new Map<string, Buffer>();

    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });

    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);
    extract.end(tarBuffer);
  });

  const registryEntry = files.get("registry.json");
  if (registryEntry !== undefined && registryEntry.length > 0 && registryPath !== undefined) {
    writeFileSync(registryPath + ".new", registryEntry);
  }

  const marketplaceEntry = files.get("marketplace.json");
  if (marketplaceEntry !== undefined && marketplaceEntry.length > 0 && marketplacePath !== undefined) {
    writeFileSync(marketplacePath + ".new", marketplaceEntry);
  }
}
