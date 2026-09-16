import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSkillStore } from "../apps/local-server/src/skill-store.ts";
import { importSkillSnapshot } from "../packages/core/src/snapshot.ts";

test("workspace Skill store preserves stable identity across immutable versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-skill-store-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source-skill");
  await mkdir(workspace);
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# Review Skill\n\nVersion one.\n");
  await writeFile(join(source, "guide.txt"), "first\n");
  const store = new WorkspaceSkillStore(workspace);
  t.after(() => store.close());

  const first = await store.importFromDirectory({ sourcePath: source });
  assert.equal(first.created, true);
  assert.equal(first.skill.name, "Review Skill");
  assert.equal(first.version.ordinal, 1);
  assert.equal(first.version.parentVersionId, null);
  assert.equal(await readFile(join(source, "guide.txt"), "utf8"), "first\n");

  await writeFile(join(source, "guide.txt"), "second\n");
  const second = await store.importFromDirectory({ sourcePath: source, skillId: first.skill.skillId });
  assert.equal(second.skill.skillId, first.skill.skillId);
  assert.equal(second.version.ordinal, 2);
  assert.equal(second.version.parentVersionId, first.version.versionId);
  assert.notEqual(second.version.treeDigest, first.version.treeDigest);

  const materialized = join(root, "materialized-v1");
  await store.materializeVersion(first.version.versionId, materialized);
  assert.equal(await readFile(join(materialized, "guide.txt"), "utf8"), "first\n");
  assert.equal((await importSkillSnapshot(materialized)).tree_digest, first.version.treeDigest);

  const duplicate = await store.importFromDirectory({ sourcePath: source, skillId: first.skill.skillId });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.version.versionId, second.version.versionId);
  assert.equal(store.listSkills()[0].versionCount, 2);

  const diff = await store.diffVersions(first.skill.skillId, first.version.versionId, second.version.versionId);
  assert.deepEqual(diff.files, [{ path: "guide.txt", status: "modified", beforeSha256: first.version.fileManifest.find((file) => file.path === "guide.txt")?.sha256 ?? null, afterSha256: second.version.fileManifest.find((file) => file.path === "guide.txt")?.sha256 ?? null }]);
});

test("workspace Skill import requires SKILL.md and rejects links outside the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-skill-safety-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source-skill");
  await mkdir(workspace);
  await mkdir(source);
  const store = new WorkspaceSkillStore(workspace);
  t.after(() => store.close());
  await assert.rejects(store.importFromDirectory({ sourcePath: source }), /SKILL\.md/);
  await writeFile(join(source, "SKILL.md"), "# Unsafe\n");
  await symlink("../outside.txt", join(source, "outside-link"));
  await assert.rejects(store.importFromDirectory({ sourcePath: source }), /external symlink/);
  assert.equal(store.listSkills().length, 0);
});

test("bounded snapshots reject oversized files before importing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-snapshot-limit-"));
  await writeFile(join(root, "SKILL.md"), "# Too large\n");
  await assert.rejects(importSkillSnapshot(root, "bounded", { maxFiles: 10, maxBytes: 4 }), /too large/);
});

test("workspace control and git metadata are excluded from imported versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-snapshot-excludes-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source");
  await mkdir(workspace);
  await mkdir(join(source, ".git"), { recursive: true });
  await mkdir(join(source, ".skillbenchmark"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# Clean\n");
  await writeFile(join(source, ".git", "config"), "private metadata\n");
  await writeFile(join(source, ".skillbenchmark", "metadata.sqlite"), "control state\n");
  const store = new WorkspaceSkillStore(workspace);
  t.after(() => store.close());
  const imported = await store.importFromDirectory({ sourcePath: source });
  assert.deepEqual(imported.version.fileManifest.map((entry) => entry.path), ["SKILL.md"]);
});
