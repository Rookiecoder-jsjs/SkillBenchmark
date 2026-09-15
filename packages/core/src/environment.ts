import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConditionId, EnvironmentHandle } from "../../contracts/src/types.ts";
import { sha256 } from "./hash.ts";
import { importSkillSnapshot } from "./snapshot.ts";

export interface EnvironmentCollection {
  root_dir: string;
  workdir: string;
  skill_path: string | null;
}

export interface EnvironmentBackend {
  provision(request: ProvisionRequest): Promise<EnvironmentHandle>;
  collect(handle: EnvironmentHandle): Promise<EnvironmentCollection>;
  destroy(handle: EnvironmentHandle): Promise<void>;
}

export interface ProvisionRequest {
  trialId: string;
  conditionId: ConditionId;
  publicInput: string;
  skillDir?: string;
  backgroundSkillDirs?: string[];
}

export class LocalEnvironmentBackend implements EnvironmentBackend {
  readonly baseDir: string;
  constructor(baseDir: string) { this.baseDir = baseDir; }

  async provision(request: ProvisionRequest): Promise<EnvironmentHandle> {
    await mkdir(resolve(this.baseDir), { recursive: true });
    const rootDir = await mkdtemp(join(resolve(this.baseDir), "trial-"));
    const workdir = join(rootDir, "work");
    const publicDir = join(rootDir, "public");
    await mkdir(workdir, { recursive: true });
    await mkdir(publicDir, { recursive: true });
    const publicInputPath = join(publicDir, "input.txt");
    await writeFile(publicInputPath, request.publicInput);
    let skillPath: string | null = null;
    if (request.conditionId !== "none" && request.skillDir) {
      await importSkillSnapshot(request.skillDir, "environment skill validation");
      skillPath = join(publicDir, "skill");
      await cp(resolve(request.skillDir), skillPath, { recursive: true, verbatimSymlinks: true });
    }
    const backgroundSkillPaths: string[] = [];
    for (const [index, backgroundDir] of (request.backgroundSkillDirs ?? []).entries()) {
      await importSkillSnapshot(backgroundDir, "environment background Skill validation");
      const destination = join(publicDir, "background-skills", String(index));
      await cp(resolve(backgroundDir), destination, { recursive: true, verbatimSymlinks: true });
      backgroundSkillPaths.push(destination);
    }
    return {
      id: request.trialId,
      root_dir: rootDir,
      workdir,
      public_input_path: publicInputPath,
      skill_path: skillPath,
      background_skill_paths: backgroundSkillPaths,
      snapshot: { backend: "local-temp", image_digest: sha256("local-temp-v0.1"), tool_versions: { node: process.version }, network_policy: "none", isolation_receipt: { root_dir: rootDir, hidden_mounts: [], user_config_visible: true } },
    };
  }

  async collect(handle: EnvironmentHandle): Promise<{ root_dir: string; workdir: string; skill_path: string | null }> {
    return { root_dir: handle.root_dir, workdir: handle.workdir, skill_path: handle.skill_path };
  }

  async destroy(handle: EnvironmentHandle): Promise<void> {
    await rm(handle.root_dir, { recursive: true, force: true });
  }
}
