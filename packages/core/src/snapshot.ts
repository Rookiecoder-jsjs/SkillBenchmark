import { lstat, open, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileManifestEntry, SkillSnapshot } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

export interface SnapshotLimits {
  maxFiles?: number;
  maxBytes?: number;
  excludePaths?: string[];
}

interface CollectionState {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
  excludePaths: Set<string>;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function account(state: CollectionState, path: string, bytes: number): void {
  state.files += 1;
  state.bytes += bytes;
  if (state.files > state.maxFiles) throw new Error(`Skill contains too many files (limit ${state.maxFiles}): ${path}`);
  if (state.bytes > state.maxBytes) throw new Error(`Skill is too large (limit ${state.maxBytes} bytes): ${path}`);
}

async function readStableFile(path: string, expectedSize: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== expectedSize) throw new Error(`Skill source changed during snapshot: ${path}`);
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error(`Skill source changed during snapshot: ${path}`);
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) throw new Error(`Skill source changed during snapshot: ${path}`);
    return bytes;
  } finally { await handle.close(); }
}

async function collect(root: string, current: string, entries: FileManifestEntry[], state: CollectionState): Promise<void> {
  for (const dirent of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, dirent.name);
    const path = relative(root, absolute).split(sep).join("/");
    if ([...state.excludePaths].some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) continue;
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (isAbsolute(target)) throw new Error(`external symlink (absolute target) is not allowed: ${path} -> ${target}`);
      const resolved = resolve(current, target);
      if (!isInside(root, resolved)) throw new Error(`external symlink is not allowed: ${path} -> ${target}`);
      account(state, path, Buffer.byteLength(target));
      entries.push({ path, sha256: sha256(target), bytes: Buffer.byteLength(target), executable: false, symlink: target });
    } else if (stat.isDirectory()) {
      account(state, path, 0);
      await collect(root, absolute, entries, state);
    } else if (stat.isFile()) {
      account(state, path, stat.size);
      const bytes = await readStableFile(absolute, stat.size);
      entries.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength, executable: (stat.mode & 0o111) !== 0 });
    }
  }
}

export async function importSkillSnapshot(sourceDir: string, label = sourceDir, limits: SnapshotLimits = {}): Promise<SkillSnapshot> {
  const root = resolve(sourceDir);
  const entries: FileManifestEntry[] = [];
  const state: CollectionState = { files: 0, bytes: 0, maxFiles: limits.maxFiles ?? Number.POSITIVE_INFINITY, maxBytes: limits.maxBytes ?? Number.POSITIVE_INFINITY, excludePaths: new Set(limits.excludePaths ?? []) };
  await collect(root, root, entries, state);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema_version: "0.1",
    skill_id: sha256(stableJson(entries)).slice(0, 16),
    label,
    tree_digest: sha256(stableJson(entries)),
    file_manifest: entries,
    requirements: [],
  };
}
