import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 250;

export interface SubprocessRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string | Uint8Array;
  timeout_ms?: number;
  max_output_bytes?: number;
  termination_grace_ms?: number;
}

export interface SubprocessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

const activeChildren = new Map<number, ChildProcess>();

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function descendantsOf(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const children = new Map<number, number[]>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const found: number[] = [];
    const seen = new Set<number>();
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length) {
      const pid = pending.pop();
      if (pid === undefined || seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return found.reverse();
  } catch {
    return [];
  }
}

function signal(pid: number, value: NodeJS.Signals): void {
  try { process.kill(pid, value); } catch { /* process may already be gone */ }
}

/** Terminates a process and descendants without passing user input to a shell. */
export function terminateProcessTree(childOrPid: ChildProcess | number, value: NodeJS.Signals = "SIGKILL", knownDescendants: number[] = []): number[] {
  const pid = typeof childOrPid === "number" ? childOrPid : childOrPid.pid;
  if (!pid) return [];
  const descendants = [...new Set([...descendantsOf(pid), ...knownDescendants])];
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.unref();
  } else {
    try { process.kill(-pid, value); } catch { /* process group may already be gone */ }
    for (const descendant of descendants) signal(descendant, value);
  }
  if (typeof childOrPid !== "number") {
    try { childOrPid.kill(value); } catch { /* process may already be gone */ }
  } else {
    signal(pid, value);
  }
  return [pid, ...descendants];
}

export function cleanupActiveSubprocesses(value: NodeJS.Signals = "SIGTERM"): void {
  const victims = [...activeChildren.values()].map((child) => ({ child, pids: terminateProcessTree(child, value) }));
  if (value === "SIGKILL") return;
  const force = setTimeout(() => {
    for (const victim of victims) terminateProcessTree(victim.child, "SIGKILL", victim.pids);
  }, DEFAULT_TERMINATION_GRACE_MS);
  force.unref();
}

interface Capture {
  chunks: Buffer[];
  bytes: number;
}

function capture(capture: Capture, chunk: string | Buffer, maxBytes: number): boolean {
  const bytes = Buffer.from(chunk);
  const remaining = maxBytes - capture.bytes;
  if (remaining <= 0) return bytes.byteLength > 0;
  const kept = bytes.subarray(0, remaining);
  capture.chunks.push(kept);
  capture.bytes += kept.byteLength;
  return kept.byteLength < bytes.byteLength;
}

function text(capture: Capture): string {
  return Buffer.concat(capture.chunks).toString("utf8");
}

export function runSubprocess(request: SubprocessRequest): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const timeoutMs = positive(request.timeout_ms, DEFAULT_SUBPROCESS_TIMEOUT_MS);
    const maxOutputBytes = positive(request.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
    const graceMs = request.termination_grace_ms !== undefined && Number.isFinite(request.termination_grace_ms) && request.termination_grace_ms >= 0
      ? Math.floor(request.termination_grace_ms)
      : DEFAULT_TERMINATION_GRACE_MS;
    let child: ChildProcess;
    try {
      child = spawn(request.command, request.args ?? [], {
        cwd: request.cwd,
        env: { ...process.env, ...(request.env ?? {}) },
        stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (child.pid) activeChildren.set(child.pid, child);
    let stdout: Capture = { chunks: [], bytes: 0 };
    let stderr: Capture = { chunks: [], bytes: 0 };
    let settled = false;
    let terminationStarted = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let knownDescendants: number[] = [];

    const finish = (result: Omit<SubprocessResult, "stdout" | "stderr" | "timedOut" | "outputLimitExceeded"> & Partial<Pick<SubprocessResult, "timedOut" | "outputLimitExceeded">>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (child.pid) activeChildren.delete(child.pid);
      resolve({ ...result, stdout: text(stdout), stderr: text(stderr), timedOut, outputLimitExceeded });
    };

    const terminate = (reason: "timeout" | "output"): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      timedOut = reason === "timeout";
      outputLimitExceeded = reason === "output";
      knownDescendants = terminateProcessTree(child, "SIGTERM");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      forceTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", knownDescendants);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: null, signal: "SIGKILL" });
      }, graceMs);
      forceTimer.unref();
    };

    timer = setTimeout(() => terminate("timeout"), timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (capture(stdout, chunk, maxOutputBytes)) terminate("output");
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (capture(stderr, chunk, maxOutputBytes)) terminate("output");
    });
    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
    child.on("close", (code, signalValue) => finish({ code, signal: signalValue }));
    if (request.input !== undefined) child.stdin?.end(request.input);
  });
}
