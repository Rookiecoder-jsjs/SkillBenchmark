import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { GateDecision, Release, SkillSnapshot } from "../../contracts/src/types.ts";
import { importSkillSnapshot } from "./snapshot.ts";

interface RegistryState {
  current_digest: string | null;
  releases: Release[];
  sources: Record<string, string>;
  events: { event: string; release_id: string; timestamp: string; from: string | null; to: string }[];
}

export class FileRegistry {
  private state: RegistryState = { current_digest: null, releases: [], sources: {}, events: [] };
  readonly root: string;

  constructor(root: string) { this.root = root; }

  async open(): Promise<void> {
    await mkdir(resolve(this.root), { recursive: true });
    const path = join(resolve(this.root), "registry.json");
    if (existsSync(path)) this.state = JSON.parse(await readFile(path, "utf8")) as RegistryState;
  }

  private async save(): Promise<void> {
    const path = join(resolve(this.root), "registry.json");
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { flag: "w" });
    await rename(temporary, path);
  }

  async publish(snapshot: SkillSnapshot, sourceDir: string, gate: GateDecision, evaluationRefs: string[] = [], scope: string[] = ["local"], expectedCurrentDigest?: string | null): Promise<Release> {
    if (gate.status !== "accept") throw new Error(`cannot publish a ${gate.status} candidate`);
    if (expectedCurrentDigest !== undefined && expectedCurrentDigest !== this.state.current_digest) throw new Error("current digest changed; refusing publish");
    if (this.state.current_digest && this.state.current_digest === snapshot.tree_digest) throw new Error("skill digest is already current");
    const release: Release = { release_id: `release-${randomUUID()}`, skill_digest: snapshot.tree_digest, evaluation_refs: evaluationRefs, scope, audit_status: "exploratory", timestamp: new Date().toISOString(), status: "published" };
    const packageDir = join(resolve(this.root), "packages", snapshot.tree_digest);
    if (existsSync(packageDir)) {
      const existing = await importSkillSnapshot(packageDir, "registry package");
      if (existing.tree_digest !== snapshot.tree_digest) throw new Error("immutable registry package is corrupted");
    } else {
      await mkdir(packageDir, { recursive: true });
      await cp(resolve(sourceDir), packageDir, { recursive: true, verbatimSymlinks: true });
    }
    for (const existing of this.state.releases) if (existing.status === "published") existing.status = "superseded";
    const from = this.state.current_digest;
    this.state.current_digest = snapshot.tree_digest;
    this.state.sources[snapshot.tree_digest] = packageDir;
    this.state.releases.push(release);
    this.state.events.push({ event: "published", release_id: release.release_id, timestamp: release.timestamp, from, to: snapshot.tree_digest });
    await this.save();
    return release;
  }

  getRelease(releaseId: string): Release {
    const release = this.state.releases.find((item) => item.release_id === releaseId);
    if (!release) throw new Error(`release not found: ${releaseId}`);
    return release;
  }

  currentDigest(): string | null { return this.state.current_digest; }

  async exportRelease(releaseId: string, platform: string, outputDir: string): Promise<{ release_id: string; platform: string; output_dir: string; skill_digest: string }> {
    const release = this.getRelease(releaseId);
    const source = this.state.sources[release.skill_digest];
    if (!source) throw new Error(`source directory not registered for ${release.skill_digest}`);
    const verified = await importSkillSnapshot(source, "registry export");
    if (verified.tree_digest !== release.skill_digest) throw new Error("registered source changed after publish");
    await mkdir(resolve(outputDir), { recursive: true });
    await cp(source, resolve(outputDir), { recursive: true, verbatimSymlinks: true });
    const receipt = { release_id: release.release_id, platform, output_dir: resolve(outputDir), skill_digest: release.skill_digest, exported_at: new Date().toISOString() };
    await writeFile(join(resolve(outputDir), "export-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }

  async rollback(releaseId: string, expectedCurrentDigest?: string): Promise<void> {
    const release = this.getRelease(releaseId);
    if (expectedCurrentDigest !== undefined && expectedCurrentDigest !== this.state.current_digest) throw new Error("current digest changed; refusing rollback");
    const from = this.state.current_digest;
    this.state.current_digest = release.skill_digest;
    for (const item of this.state.releases) item.status = item.release_id === release.release_id ? "published" : "superseded";
    this.state.events.push({ event: "rollback", release_id: release.release_id, timestamp: new Date().toISOString(), from, to: release.skill_digest });
    await this.save();
  }
}
