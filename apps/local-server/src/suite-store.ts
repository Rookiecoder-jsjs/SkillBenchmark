import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import type { SuiteSnapshot } from "../../../packages/contracts/src/types.ts";
import { ObjectStore } from "../../../packages/core/src/object-store.ts";
import { parseSuite } from "../../../packages/core/src/suite.ts";

const MAX_SUITE_BYTES = 2 * 1024 * 1024;

export interface WorkspaceSuiteVersion {
  versionId: string;
  suiteId: string;
  parentVersionId: string | null;
  ordinal: number;
  digest: string;
  label: string;
  sourcePath: string;
  createdAt: string;
  taskCount: number;
  snapshot: SuiteSnapshot;
}
export type PublicWorkspaceSuiteVersion = Omit<WorkspaceSuiteVersion, "snapshot">;

export interface WorkspaceSuite {
  suiteId: string;
  name: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  latestVersion: PublicWorkspaceSuiteVersion | null;
}

interface SuiteRow { suite_id: string; name: string; source_path: string; created_at: string; updated_at: string; version_count?: number }
interface SuiteVersionRow { version_id: string; suite_id: string; parent_version_id: string | null; ordinal: number; digest: string; label: string; source_path: string; created_at: string; snapshot_json: string }

function versionFromRow(row: SuiteVersionRow): WorkspaceSuiteVersion {
  const snapshot = JSON.parse(row.snapshot_json) as SuiteSnapshot;
  return { versionId: row.version_id, suiteId: row.suite_id, parentVersionId: row.parent_version_id, ordinal: row.ordinal, digest: row.digest, label: row.label, sourcePath: row.source_path, createdAt: row.created_at, taskCount: snapshot.tasks.length, snapshot };
}

export function publicSuiteVersion(version: WorkspaceSuiteVersion): PublicWorkspaceSuiteVersion {
  const { snapshot: _snapshot, ...summary } = version;
  return summary;
}

export class WorkspaceSuiteStore {
  readonly workspaceRoot: string;
  readonly db: DatabaseSync;
  readonly objects: ObjectStore;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    const stateRoot = join(this.workspaceRoot, ".skillbenchmark");
    mkdirSync(stateRoot, { recursive: true });
    this.db = new DatabaseSync(join(stateRoot, "metadata.sqlite"));
    this.objects = new ObjectStore(join(stateRoot, "objects", "sha256"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspace_suites (
        suite_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_suite_versions (
        version_id TEXT PRIMARY KEY,
        suite_id TEXT NOT NULL REFERENCES workspace_suites(suite_id),
        parent_version_id TEXT REFERENCES workspace_suite_versions(version_id),
        ordinal INTEGER NOT NULL,
        digest TEXT NOT NULL,
        label TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        object_digest TEXT NOT NULL,
        UNIQUE(suite_id, ordinal),
        UNIQUE(suite_id, digest)
      );
    `);
  }

  private version(versionId: string): WorkspaceSuiteVersion {
    const row = this.db.prepare("SELECT * FROM workspace_suite_versions WHERE version_id = ?").get(versionId) as SuiteVersionRow | undefined;
    if (!row) throw new Error(`Suite version not found: ${versionId}`);
    return versionFromRow(row);
  }

  private suite(suiteId: string): WorkspaceSuite {
    const row = this.db.prepare("SELECT s.*, COUNT(v.version_id) AS version_count FROM workspace_suites s LEFT JOIN workspace_suite_versions v ON v.suite_id = s.suite_id WHERE s.suite_id = ? GROUP BY s.suite_id").get(suiteId) as SuiteRow | undefined;
    if (!row) throw new Error(`Suite not found: ${suiteId}`);
    const latest = this.db.prepare("SELECT * FROM workspace_suite_versions WHERE suite_id = ? ORDER BY ordinal DESC LIMIT 1").get(suiteId) as SuiteVersionRow | undefined;
    return { suiteId: row.suite_id, name: row.name, sourcePath: row.source_path, createdAt: row.created_at, updatedAt: row.updated_at, versionCount: Number(row.version_count ?? 0), latestVersion: latest ? publicSuiteVersion(versionFromRow(latest)) : null };
  }

  listSuites(): WorkspaceSuite[] {
    const rows = this.db.prepare("SELECT suite_id FROM workspace_suites ORDER BY updated_at DESC").all() as unknown as Array<{ suite_id: string }>;
    return rows.map((row) => this.suite(row.suite_id));
  }

  getSuite(suiteId: string): { suite: WorkspaceSuite; versions: PublicWorkspaceSuiteVersion[] } {
    const suite = this.suite(suiteId);
    const rows = this.db.prepare("SELECT * FROM workspace_suite_versions WHERE suite_id = ? ORDER BY ordinal DESC").all(suiteId) as unknown as SuiteVersionRow[];
    return { suite, versions: rows.map(versionFromRow).map(publicSuiteVersion) };
  }

  getVersion(versionId: string): WorkspaceSuiteVersion { return this.version(versionId); }

  async importFromFile(source: string): Promise<{ created: boolean; suite: WorkspaceSuite; version: WorkspaceSuiteVersion }> {
    const requested = resolve(this.workspaceRoot, source);
    if (!existsSync(requested) || !(await stat(requested)).isFile()) throw new Error("Suite source must be an existing JSON file");
    const sourcePath = await realpath(requested);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.size > MAX_SUITE_BYTES) throw new Error(`Suite file exceeds ${MAX_SUITE_BYTES} bytes`);
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength > MAX_SUITE_BYTES) throw new Error(`Suite file exceeds ${MAX_SUITE_BYTES} bytes`);
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Suite source must contain valid JSON"); }
    const snapshot = parseSuite(raw);
    const stored = await this.objects.put(bytes);
    const existingSuite = this.db.prepare("SELECT suite_id FROM workspace_suites WHERE suite_id = ?").get(snapshot.suite_id) as { suite_id: string } | undefined;
    const sourceMatch = this.db.prepare("SELECT suite_id FROM workspace_suites WHERE source_path = ?").get(sourcePath) as { suite_id: string } | undefined;
    if (sourceMatch && sourceMatch.suite_id !== snapshot.suite_id) throw new Error("Suite source changed its suite_id; import it from a new file");
    const duplicate = this.db.prepare("SELECT * FROM workspace_suite_versions WHERE suite_id = ? AND digest = ?").get(snapshot.suite_id, snapshot.digest) as SuiteVersionRow | undefined;
    if (duplicate) return { created: false, suite: this.suite(snapshot.suite_id), version: versionFromRow(duplicate) };
    const latest = existingSuite ? this.db.prepare("SELECT * FROM workspace_suite_versions WHERE suite_id = ? ORDER BY ordinal DESC LIMIT 1").get(snapshot.suite_id) as SuiteVersionRow | undefined : undefined;
    const now = new Date().toISOString();
    const versionId = `suite-version-${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existingSuite) this.db.prepare("INSERT INTO workspace_suites(suite_id, name, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(snapshot.suite_id, snapshot.label, sourcePath, now, now);
      else this.db.prepare("UPDATE workspace_suites SET name = ?, source_path = ?, updated_at = ? WHERE suite_id = ?").run(snapshot.label, sourcePath, now, snapshot.suite_id);
      this.db.prepare("INSERT INTO workspace_suite_versions(version_id, suite_id, parent_version_id, ordinal, digest, label, source_path, created_at, snapshot_json, object_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(versionId, snapshot.suite_id, latest?.version_id ?? null, (latest?.ordinal ?? 0) + 1, snapshot.digest, snapshot.label, sourcePath, now, JSON.stringify(snapshot), stored.digest);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { created: true, suite: this.suite(snapshot.suite_id), version: this.version(versionId) };
  }

  close(): void { this.db.close(); }
}
