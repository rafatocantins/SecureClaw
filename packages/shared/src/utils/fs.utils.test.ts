import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileSync } from "./fs.utils.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tessera-fs-utils-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("replaceFileSync", () => {
  it("renames src to dst when dst does not exist", () => {
    const src = join(tmpDir, "src.txt");
    const dst = join(tmpDir, "dst.txt");
    writeFileSync(src, "new-content");

    replaceFileSync(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dst, "utf-8")).toBe("new-content");
  });

  it("replaces an existing dst (POSIX atomic rename)", () => {
    const src = join(tmpDir, "src.txt");
    const dst = join(tmpDir, "dst.txt");
    writeFileSync(src, "new-content");
    writeFileSync(dst, "old-content");

    replaceFileSync(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dst, "utf-8")).toBe("new-content");
  });

  it("removes existing dst before rename on win32", () => {
    const src = join(tmpDir, "src.txt");
    const dst = join(tmpDir, "dst.txt");
    writeFileSync(src, "new-content");
    writeFileSync(dst, "old-content");

    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    try {
      replaceFileSync(src, dst);
    } finally {
      platformSpy.mockRestore();
    }

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dst, "utf-8")).toBe("new-content");
  });

  it("win32 path with absent dst skips the unlink", () => {
    const src = join(tmpDir, "src.txt");
    const dst = join(tmpDir, "dst.txt");
    writeFileSync(src, "new-content");

    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    try {
      replaceFileSync(src, dst);
    } finally {
      platformSpy.mockRestore();
    }

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dst, "utf-8")).toBe("new-content");
  });

  it("propagates the error when src does not exist", () => {
    const src = join(tmpDir, "missing.txt");
    const dst = join(tmpDir, "dst.txt");

    expect(() => replaceFileSync(src, dst)).toThrow();
  });
});
