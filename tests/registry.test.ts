import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRegistry } from "../packages/core/src/registry.ts";
import { importSkillSnapshot } from "../packages/core/src/snapshot.ts";

const accepted = { decision_id: "decision-test", comparison_refs: [], policy: { min_iteration_gain: 0, min_iteration_ci_lower: -1, max_relative_none_loss: -1, max_missing_pair_rate: 1, max_key_regressions: 100 }, status: "accept" as const, reasons: ["test policy"] };

test("registry publishes, exports and rolls back immutable Skill releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-registry-"));
  const parentDir = join(root, "parent");
  const candidateDir = join(root, "candidate");
  await writeFile(join(await mkdtemp(join(tmpdir(), "skillbenchmark-source-")), "placeholder"), "placeholder");
  await import("node:fs/promises").then(async ({ mkdir }) => { await mkdir(parentDir); await mkdir(candidateDir); });
  await writeFile(join(parentDir, "SKILL.md"), "# Parent\n");
  await writeFile(join(candidateDir, "SKILL.md"), "# Candidate\n");
  const parent = await importSkillSnapshot(parentDir, "parent");
  const candidate = await importSkillSnapshot(candidateDir, "candidate");
  const registry = new FileRegistry(join(root, "registry"));
  await registry.open();
  const first = await registry.publish(parent, parentDir, accepted, ["run-parent"], ["fake"], null);
  const second = await registry.publish(candidate, candidateDir, accepted, ["run-candidate"], ["fake"], parent.tree_digest);
  assert.equal(registry.currentDigest(), candidate.tree_digest);
  const exportDir = join(root, "export");
  const receipt = await registry.exportRelease(second.release_id, "codex", exportDir);
  assert.equal(receipt.skill_digest, candidate.tree_digest);
  assert.match(await readFile(join(exportDir, "export-receipt.json"), "utf8"), /codex/);
  await writeFile(join(candidateDir, "SKILL.md"), "# Mutated after publish\n");
  const immutableExport = join(root, "immutable-export");
  await registry.exportRelease(second.release_id, "claude-code", immutableExport);
  assert.equal(await readFile(join(immutableExport, "SKILL.md"), "utf8"), "# Candidate\n");
  await registry.rollback(first.release_id, candidate.tree_digest);
  assert.equal(registry.currentDigest(), parent.tree_digest);
});

test("registry refuses to publish a rejected candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-registry-reject-"));
  const source = join(root, "skill");
  await import("node:fs/promises").then(async ({ mkdir }) => mkdir(source));
  await writeFile(join(source, "SKILL.md"), "# Skill\n");
  const snapshot = await importSkillSnapshot(source, "skill");
  const registry = new FileRegistry(join(root, "registry"));
  await registry.open();
  await assert.rejects(registry.publish(snapshot, source, { ...accepted, status: "reject" }), /cannot publish/);
});
