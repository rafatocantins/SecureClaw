import { existsSync, renameSync, unlinkSync } from "node:fs";

/**
 * Replaces the file at `dst` with the file at `src`, moving (renaming) `src`
 * into place. Cross-platform: on win32, `renameSync` fails with EPERM/EEXIST
 * when the destination already exists, so the destination is removed first;
 * on POSIX the rename stays atomic and replaces the destination in place.
 *
 * NOTE: if the destination is currently held open by another handle (e.g. a
 * `node:sqlite` DatabaseSync connection), `unlinkSync`/`renameSync` will fail
 * with EPERM on win32 regardless — callers MUST close such handles before
 * calling this (production migrations run at startup, before any connection
 * is opened).
 *
 * @param src Source file path (moved, no longer exists after success).
 * @param dst Destination file path (overwritten).
 */
export function replaceFileSync(src: string, dst: string): void {
  if (process.platform === "win32" && existsSync(dst)) {
    unlinkSync(dst);
  }
  renameSync(src, dst);
}
