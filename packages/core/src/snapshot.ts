import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { FileManifestEntry, SkillSnapshot } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function collect(root: string, current: string, entries: FileManifestEntry[]): Promise<void> {
  for (const dirent of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, dirent.name);
    const path = relative(root, absolute).split(sep).join("/");
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = resolve(current, target);
      if (!isInside(root, resolved)) throw new Error(`external symlink is not allowed: ${path} -> ${target}`);
      entries.push({ path, sha256: sha256(target), bytes: Buffer.byteLength(target), executable: false, symlink: target });
    } else if (stat.isDirectory()) {
      await collect(root, absolute, entries);
    } else if (stat.isFile()) {
      const bytes = await readFile(absolute);
      entries.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength, executable: (stat.mode & 0o111) !== 0 });
    }
  }
}

export async function importSkillSnapshot(sourceDir: string, label = sourceDir): Promise<SkillSnapshot> {
  const root = resolve(sourceDir);
  const entries: FileManifestEntry[] = [];
  await collect(root, root, entries);
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
