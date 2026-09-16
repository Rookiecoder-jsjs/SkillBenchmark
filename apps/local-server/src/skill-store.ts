import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, readlink, realpath, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, join, resolve } from "node:path";
import type { FileManifestEntry } from "../../../packages/contracts/src/types.ts";
import { sha256 } from "../../../packages/core/src/hash.ts";
import { ObjectStore } from "../../../packages/core/src/object-store.ts";
import { importSkillSnapshot } from "../../../packages/core/src/snapshot.ts";

const MAX_SKILL_FILES = 2_000;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;
const IMPORT_EXCLUDES = [".git", ".skillbenchmark"];

export interface WorkspaceSkill {
  skillId: string;
  name: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  latestVersion: SkillVersion | null;
}

export interface SkillVersion {
  versionId: string;
  skillId: string;
  parentVersionId: string | null;
  ordinal: number;
  treeDigest: string;
  label: string;
  sourcePath: string;
  createdAt: string;
  fileManifest: FileManifestEntry[];
}

export interface VersionDiff {
  skillId: string;
  fromVersionId: string;
  toVersionId: string;
  files: Array<{ path: string; status: "added" | "removed" | "modified"; beforeSha256: string | null; afterSha256: string | null }>;
}

interface SkillRow { skill_id: string; name: string; source_path: string; created_at: string; updated_at: string; version_count?: number }
interface VersionRow { version_id: string; skill_id: string; parent_version_id: string | null; ordinal: number; tree_digest: string; label: string; source_path: string; created_at: string; manifest_json: string }

function versionFromRow(row: VersionRow): SkillVersion {
  return { versionId: row.version_id, skillId: row.skill_id, parentVersionId: row.parent_version_id, ordinal: row.ordinal, treeDigest: row.tree_digest, label: row.label, sourcePath: row.source_path, createdAt: row.created_at, fileManifest: JSON.parse(row.manifest_json) as FileManifestEntry[] };
}

function skillName(markdown: string, sourcePath: string): string {
  const heading = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || basename(sourcePath);
}

export class WorkspaceSkillStore {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly db: DatabaseSync;
  readonly objects: ObjectStore;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.stateRoot = join(this.workspaceRoot, ".skillbenchmark");
    mkdirSync(this.stateRoot, { recursive: true });
    this.db = new DatabaseSync(join(this.stateRoot, "metadata.sqlite"));
    this.objects = new ObjectStore(join(this.stateRoot, "objects", "sha256"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspace_skills (
        skill_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_skill_versions (
        version_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES workspace_skills(skill_id),
        parent_version_id TEXT REFERENCES workspace_skill_versions(version_id),
        ordinal INTEGER NOT NULL,
        tree_digest TEXT NOT NULL,
        label TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        UNIQUE(skill_id, ordinal),
        UNIQUE(skill_id, tree_digest)
      );
    `);
  }

  private version(versionId: string): SkillVersion {
    const row = this.db.prepare("SELECT * FROM workspace_skill_versions WHERE version_id = ?").get(versionId) as VersionRow | undefined;
    if (!row) throw new Error(`Skill version not found: ${versionId}`);
    return versionFromRow(row);
  }

  private skill(skillId: string): WorkspaceSkill {
    const row = this.db.prepare("SELECT s.*, COUNT(v.version_id) AS version_count FROM workspace_skills s LEFT JOIN workspace_skill_versions v ON v.skill_id = s.skill_id WHERE s.skill_id = ? GROUP BY s.skill_id").get(skillId) as SkillRow | undefined;
    if (!row) throw new Error(`Skill not found: ${skillId}`);
    const latest = this.db.prepare("SELECT * FROM workspace_skill_versions WHERE skill_id = ? ORDER BY ordinal DESC LIMIT 1").get(skillId) as VersionRow | undefined;
    return { skillId: row.skill_id, name: row.name, sourcePath: row.source_path, createdAt: row.created_at, updatedAt: row.updated_at, versionCount: Number(row.version_count ?? 0), latestVersion: latest ? versionFromRow(latest) : null };
  }

  listSkills(): WorkspaceSkill[] {
    const rows = this.db.prepare("SELECT s.*, COUNT(v.version_id) AS version_count FROM workspace_skills s LEFT JOIN workspace_skill_versions v ON v.skill_id = s.skill_id GROUP BY s.skill_id ORDER BY s.updated_at DESC").all() as unknown as SkillRow[];
    return rows.map((row) => this.skill(row.skill_id));
  }

  getSkill(skillId: string): { skill: WorkspaceSkill; versions: SkillVersion[] } {
    const skill = this.skill(skillId);
    const rows = this.db.prepare("SELECT * FROM workspace_skill_versions WHERE skill_id = ? ORDER BY ordinal DESC").all(skillId) as unknown as VersionRow[];
    return { skill, versions: rows.map(versionFromRow) };
  }

  async importFromDirectory(input: { sourcePath: string; skillId?: string; name?: string }): Promise<{ created: boolean; skill: WorkspaceSkill; version: SkillVersion }> {
    const requested = resolve(this.workspaceRoot, input.sourcePath);
    if (!existsSync(requested) || !(await stat(requested)).isDirectory()) throw new Error("Skill source must be an existing directory");
    const sourcePath = await realpath(requested);
    const first = await importSkillSnapshot(sourcePath, input.name ?? sourcePath, { maxFiles: MAX_SKILL_FILES, maxBytes: MAX_SKILL_BYTES, excludePaths: IMPORT_EXCLUDES });
    if (!first.file_manifest.some((entry) => entry.path === "SKILL.md" && entry.symlink === undefined)) throw new Error("Skill source must contain a regular SKILL.md file");

    for (const entry of first.file_manifest) {
      const absolute = join(sourcePath, ...entry.path.split("/"));
      const bytes = entry.symlink === undefined ? await readFile(absolute) : Buffer.from(await readlink(absolute));
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Skill source changed during import: ${entry.path}`);
      await this.objects.put(bytes);
    }
    const second = await importSkillSnapshot(sourcePath, input.name ?? sourcePath, { maxFiles: MAX_SKILL_FILES, maxBytes: MAX_SKILL_BYTES, excludePaths: IMPORT_EXCLUDES });
    if (second.tree_digest !== first.tree_digest) throw new Error("Skill source changed during import; retry after changes finish");

    const sourceMatch = this.db.prepare("SELECT skill_id FROM workspace_skills WHERE source_path = ?").get(sourcePath) as { skill_id: string } | undefined;
    const skillId = input.skillId ?? sourceMatch?.skill_id ?? `skill-${randomUUID()}`;
    const existingSkill = this.db.prepare("SELECT skill_id FROM workspace_skills WHERE skill_id = ?").get(skillId) as { skill_id: string } | undefined;
    if (input.skillId && !existingSkill) throw new Error(`Skill not found: ${input.skillId}`);
    if (sourceMatch && sourceMatch.skill_id !== skillId) throw new Error("Skill source is already assigned to another Skill");
    const duplicate = this.db.prepare("SELECT * FROM workspace_skill_versions WHERE skill_id = ? AND tree_digest = ?").get(skillId, first.tree_digest) as VersionRow | undefined;
    if (duplicate) return { created: false, skill: this.skill(skillId), version: versionFromRow(duplicate) };

    const latest = existingSkill ? this.db.prepare("SELECT * FROM workspace_skill_versions WHERE skill_id = ? ORDER BY ordinal DESC LIMIT 1").get(skillId) as VersionRow | undefined : undefined;
    const now = new Date().toISOString();
    const versionId = `version-${randomUUID()}`;
    const skillEntry = first.file_manifest.find((entry) => entry.path === "SKILL.md")!;
    const name = input.name?.trim() || skillName((await this.objects.get(skillEntry.sha256)).toString("utf8"), sourcePath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existingSkill) this.db.prepare("INSERT INTO workspace_skills(skill_id, name, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(skillId, name, sourcePath, now, now);
      else this.db.prepare("UPDATE workspace_skills SET name = ?, source_path = ?, updated_at = ? WHERE skill_id = ?").run(input.name?.trim() || this.skill(skillId).name, sourcePath, now, skillId);
      this.db.prepare("INSERT INTO workspace_skill_versions(version_id, skill_id, parent_version_id, ordinal, tree_digest, label, source_path, created_at, manifest_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(versionId, skillId, latest?.version_id ?? null, (latest?.ordinal ?? 0) + 1, first.tree_digest, first.label, sourcePath, now, JSON.stringify(first.file_manifest));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { created: true, skill: this.skill(skillId), version: this.version(versionId) };
  }

  async diffVersions(skillId: string, fromVersionId: string, toVersionId: string): Promise<VersionDiff> {
    const from = this.version(fromVersionId);
    const to = this.version(toVersionId);
    if (from.skillId !== skillId || to.skillId !== skillId) throw new Error("Versions do not belong to the requested Skill");
    const before = new Map(from.fileManifest.map((entry) => [entry.path, entry]));
    const after = new Map(to.fileManifest.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const files: VersionDiff["files"] = [];
    for (const path of paths) {
      const left = before.get(path);
      const right = after.get(path);
      if (left?.sha256 === right?.sha256 && left?.executable === right?.executable && left?.symlink === right?.symlink) continue;
      files.push({ path, status: !left ? "added" : !right ? "removed" : "modified", beforeSha256: left?.sha256 ?? null, afterSha256: right?.sha256 ?? null });
    }
    return { skillId, fromVersionId, toVersionId, files };
  }

  close(): void { this.db.close(); }
}
