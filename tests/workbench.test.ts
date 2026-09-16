import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAgents, resolveWorkspaceRoot } from "../apps/local-server/src/discovery.ts";
import { startLocalWorkbench } from "../apps/local-server/src/server.ts";

test("workspace selection prefers an explicit path and otherwise preserves npm INIT_CWD", () => {
  assert.equal(resolveWorkspaceRoot({ explicit: "./fixtures", initCwd: "/tmp/npm-project", cwd: "/tmp/tool" }), resolve("fixtures"));
  assert.equal(resolveWorkspaceRoot({ initCwd: "/tmp/npm-project", cwd: "/tmp/tool" }), "/tmp/npm-project");
  assert.equal(resolveWorkspaceRoot({ cwd: "/tmp/tool" }), "/tmp/tool");
});

test("agent discovery records installation separately from authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-discovery-"));
  const fakeCodex = join(root, "codex");
  await writeFile(fakeCodex, "#!/bin/sh\necho 'codex-cli 9.9.9'\n");
  await chmod(fakeCodex, 0o755);

  const agents = await discoverAgents({ workspaceRoot: root, commands: { codex: fakeCodex, "claude-code": join(root, "missing-claude") }, timeoutMs: 1_000 });
  const codex = agents.find((agent) => agent.id === "codex");
  const claude = agents.find((agent) => agent.id === "claude-code");
  assert.equal(codex?.installation, "found");
  assert.equal(codex?.authentication, "unknown");
  assert.equal(codex?.version, "codex-cli 9.9.9");
  assert.equal(codex?.executablePath, await realpath(fakeCodex));
  assert.equal(claude?.installation, "missing");
});

test("local workbench exposes authenticated same-origin workspace and discovery APIs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-workbench-"));
  const fakeCodex = join(root, "codex");
  await writeFile(fakeCodex, "#!/bin/sh\necho 'codex-cli test'\n");
  await chmod(fakeCodex, 0o755);
  const workbench = await startLocalWorkbench({
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    openBrowser: false,
    serveWebApp: false,
    agentCommands: { codex: fakeCodex },
  });
  t.after(() => workbench.close());

  const unauthorized = await fetch(`${workbench.origin}/api/v1/workspace`);
  assert.equal(unauthorized.status, 401);

  const bootstrap = await fetch(workbench.browserUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.get("location"), "/");
  assert.match(bootstrap.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const cookieWorkspace = await fetch(`${workbench.origin}/api/v1/workspace`, { headers: { cookie, origin: workbench.origin } });
  assert.equal(cookieWorkspace.status, 200);

  const headers = { "x-skillbenchmark-token": workbench.token, origin: workbench.origin };
  const workspace = await fetch(`${workbench.origin}/api/v1/workspace`, { headers });
  assert.equal(workspace.status, 200);
  assert.equal((await workspace.json() as { root: string }).root, root);

  const rejectedOrigin = await fetch(`${workbench.origin}/api/v1/agents`, {
    headers: { "x-skillbenchmark-token": workbench.token, origin: "https://example.invalid" },
  });
  assert.equal(rejectedOrigin.status, 403);

  const agents = await fetch(`${workbench.origin}/api/v1/agents`, { headers });
  assert.equal(agents.status, 200);
  assert.equal(((await agents.json() as { agents: Array<{ id: string; installation: string }> }).agents.find((agent) => agent.id === "codex"))?.installation, "found");

  const source = join(root, "sample-skill");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# API Skill\n");
  const imported = await fetch(`${workbench.origin}/api/v1/skills/import`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ sourcePath: source }) });
  assert.equal(imported.status, 201);
  const importedBody = await imported.json() as { skill: { skillId: string }; version: { versionId: string } };
  const skills = await fetch(`${workbench.origin}/api/v1/skills`, { headers });
  assert.equal(skills.status, 200);
  assert.equal((await skills.json() as { skills: unknown[] }).skills.length, 1);
  const detail = await fetch(`${workbench.origin}/api/v1/skills/${importedBody.skill.skillId}`, { headers });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { versions: unknown[] }).versions.length, 1);

  const invalidImport = await fetch(`${workbench.origin}/api/v1/skills/import`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ sourcePath: "" }) });
  assert.equal(invalidImport.status, 400);
  assert.ok(importedBody.version.versionId);
});
