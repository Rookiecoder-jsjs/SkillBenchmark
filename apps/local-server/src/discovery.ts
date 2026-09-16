import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { runSubprocess } from "../../../packages/core/src/subprocess.ts";

export type AgentId = "codex" | "claude-code";
export type InstallationStatus = "missing" | "found" | "broken";
export type AuthenticationStatus = "unknown" | "ready" | "required" | "failed";

export interface AgentDiscovery {
  id: AgentId;
  name: string;
  installation: InstallationStatus;
  authentication: AuthenticationStatus;
  evaluationSupport: "exploratory" | "verified" | "unsupported";
  executablePath: string | null;
  version: string | null;
  capabilities: string[];
  detectedAt: string;
  evidence: string[];
}

export interface DiscoveryOptions {
  workspaceRoot: string;
  commands?: Partial<Record<AgentId, string>>;
  timeoutMs?: number;
  pathValue?: string;
}

interface AgentDefinition {
  id: AgentId;
  name: string;
  command: string;
  knownPaths: () => string[];
  capabilities: string[];
}

const definitions: AgentDefinition[] = [
  {
    id: "codex",
    name: "Codex",
    command: process.platform === "win32" ? "codex.exe" : "codex",
    knownPaths: () => [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
    capabilities: ["non-interactive", "structured-output", "controlled", "coexistence"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: process.platform === "win32" ? "claude.exe" : "claude",
    knownPaths: () => [join(homedir(), ".local/bin/claude"), join(homedir(), ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
    capabilities: ["non-interactive", "structured-output", "controlled", "native", "coexistence"],
  },
];

export function resolveWorkspaceRoot(options: { explicit?: string; initCwd?: string; cwd: string }): string {
  return resolve(options.explicit || options.initCwd || options.cwd);
}

async function executable(path: string): Promise<string | null> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return await realpath(path);
  } catch {
    return null;
  }
}

async function locate(definition: AgentDefinition, explicit: string | undefined, pathValue: string): Promise<{ path: string | null; evidence: string[] }> {
  if (explicit !== undefined) {
    const candidate = isAbsolute(explicit) ? explicit : resolve(explicit);
    const found = await executable(candidate);
    return { path: found, evidence: found ? ["configured executable"] : [`configured executable is unavailable: ${candidate}`] };
  }
  const pathCandidates = pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, definition.command));
  for (const candidate of [...pathCandidates, ...definition.knownPaths()]) {
    const found = await executable(candidate);
    if (found) return { path: found, evidence: [pathCandidates.includes(candidate) ? "found on PATH" : "found in a known install location"] };
  }
  return { path: null, evidence: ["executable not found"] };
}

async function probe(definition: AgentDefinition, options: DiscoveryOptions): Promise<AgentDiscovery> {
  const detectedAt = new Date().toISOString();
  const located = await locate(definition, options.commands?.[definition.id], options.pathValue ?? process.env.PATH ?? "");
  if (!located.path) {
    return { id: definition.id, name: definition.name, installation: "missing", authentication: "unknown", evaluationSupport: "unsupported", executablePath: null, version: null, capabilities: [], detectedAt, evidence: located.evidence };
  }
  const result = await runSubprocess({ command: located.path, args: ["--version"], cwd: options.workspaceRoot, timeout_ms: options.timeoutMs ?? 5_000, max_output_bytes: 64 * 1024 });
  const output = (result.stdout || result.stderr).trim();
  if (result.code !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnError) {
    const reason = result.spawnError ?? (result.timedOut ? "version probe timed out" : result.outputLimitExceeded ? "version output exceeded limit" : output || `version probe exited with ${result.code}`);
    return { id: definition.id, name: definition.name, installation: "broken", authentication: "unknown", evaluationSupport: "unsupported", executablePath: located.path, version: null, capabilities: [], detectedAt, evidence: [...located.evidence, reason] };
  }
  return {
    id: definition.id,
    name: definition.name,
    installation: "found",
    authentication: "unknown",
    evaluationSupport: "exploratory",
    executablePath: located.path,
    version: output.split(/\r?\n/, 1)[0] || null,
    capabilities: definition.capabilities,
    detectedAt,
    evidence: [...located.evidence, output].filter(Boolean),
  };
}

export async function discoverAgents(options: DiscoveryOptions): Promise<AgentDiscovery[]> {
  return Promise.all(definitions.map((definition) => probe(definition, options)));
}
