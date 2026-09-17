import { StrictMode, useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { RunPlan, RunReport, TraceEvent } from "../../../packages/contracts/src/types.ts";
import { buildRunComparison, buildRunDetailView, formatDuration } from "./run-view.ts";
import "./styles.css";

interface Workspace { name: string; root: string }
interface Agent {
  id: string;
  name: string;
  installation: "missing" | "found" | "broken";
  authentication: "unknown" | "ready" | "required" | "failed";
  evaluationSupport: "exploratory" | "verified" | "unsupported";
  executablePath: string | null;
  version: string | null;
  capabilities: string[];
  evidence: string[];
}
interface ManifestEntry { path: string; sha256: string; bytes: number; executable: boolean; symlink?: string }
interface SkillVersion { versionId: string; skillId: string; parentVersionId: string | null; ordinal: number; treeDigest: string; label: string; sourcePath: string; createdAt: string; fileManifest: ManifestEntry[] }
interface Skill { skillId: string; name: string; sourcePath: string; createdAt: string; updatedAt: string; versionCount: number; latestVersion: SkillVersion | null }
interface SkillDetail { skill: Skill; versions: SkillVersion[] }
interface VersionDiff { files: Array<{ path: string; status: "added" | "removed" | "modified" }> }
interface SuiteVersion { versionId: string; suiteId: string; parentVersionId: string | null; ordinal: number; digest: string; label: string; sourcePath: string; createdAt: string; taskCount: number }
interface Suite { suiteId: string; name: string; sourcePath: string; createdAt: string; updatedAt: string; versionCount: number; latestVersion: SuiteVersion | null }
interface WorkbenchPlan { planId: string; name: string; experimentType: "trial" | "effectiveness" | "version-comparison"; status: "ready"; createdAt: string; planDigest: string; suite: { suiteId: string; versionId: string; digest: string; label: string; taskCount: number }; agent: { id: string; name: string; version: string | null; evaluationSupport: string; model: string }; bindings: { incumbent?: { versionId: string; treeDigest: string }; candidate?: { versionId: string; treeDigest: string } }; corePlan: RunPlan }
interface RunProgress { type: "trial.running" | "trace.event" | "trial.finished"; trial_id: string; timestamp: string; status?: string; event?: TraceEvent }
interface WorkbenchRun { runId: string; planId: string; name: string; status: "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed"; createdAt: string; startedAt: string | null; finishedAt: string | null; trialCount: number; completedTrials: number; trialStatuses: Record<string, string>; events: RunProgress[]; error: string | null }
interface WorkbenchRunDetail extends WorkbenchRun { report: RunReport | null }
interface ReleaseRecord { release_id: string; skill_digest: string; evaluation_refs: string[]; scope: string[]; audit_status: "exploratory" | "verified"; timestamp: string; status: "published" | "superseded" }
interface ReleaseItem { release: ReleaseRecord; isCurrent: boolean; version: { versionId: string; ordinal: number; label: string; treeDigest: string } | null }
interface EligibleReleaseRun { runId: string; name: string; finishedAt: string; decisionId: string; candidateVersionId: string; candidateTreeDigest: string; suite: { label: string; digest: string }; agent: { id: string; name: string; model: string; evaluationSupport: string } }
interface ReleaseView { skillId: string; currentDigest: string | null; releases: ReleaseItem[]; events: Array<{ event: "published" | "rollback"; release_id: string; timestamp: string; from: string | null; to: string }>; eligibleRuns: EligibleReleaseRun[] }
interface ExportReceipt { release_id: string; platform: string; output_dir: string; skill_digest: string; exported_at: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(problem?.error ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

function AgentCard({ agent }: { agent: Agent }) {
  const installed = agent.installation === "found";
  const status = installed ? "已安装" : agent.installation === "broken" ? "不可用" : "未发现";
  return <article className="agent-card">
    <div className={`agent-mark ${agent.id === "codex" ? "codex" : "claude"}`}>{agent.name.slice(0, 1)}</div>
    <div className="agent-copy">
      <div className="agent-title"><h3>{agent.name}</h3><span className={`pill ${installed ? "success" : agent.installation === "broken" ? "danger" : "muted"}`}>{status}</span></div>
      <p>{agent.version ?? "等待本机安装"}</p>
      <small>{agent.executablePath ?? agent.evidence[0]}</small>
    </div>
  </article>;
}

function percent(value: number | null): string { return value === null ? "unknown" : `${(value * 100).toFixed(1)}%`; }

function RunDetailModal({ run, plan, loading, error, onClose }: { run: WorkbenchRunDetail | null; plan?: WorkbenchPlan; loading: boolean; error: string; onClose: () => void }) {
  const view = run ? buildRunDetailView(run) : null;
  const primaryContrast = view?.contrasts.find((contrast) => contrast.left === "incumbent" && contrast.right === "candidate") ?? view?.contrasts[0];
  return <div className="modal-backdrop run-detail-backdrop" role="presentation">
    <section className="run-detail-modal" role="dialog" aria-modal="true" aria-label="运行结果详情">
      <div className="modal-head"><div><span className="section-label">RUN EVIDENCE</span><h2>{run?.name ?? "正在读取运行"}</h2>{run && <code>{run.runId} · {plan?.agent.name ?? "Agent"} · {plan?.agent.model === "default" ? "本机默认模型" : plan?.agent.model ?? "未知模型"}</code>}</div><button type="button" className="modal-close" aria-label="关闭运行详情" onClick={onClose}>×</button></div>
      {loading && !run && <div className="detail-loading">正在读取保存的运行证据…</div>}
      {error && <div className="error compact">{error}</div>}
      {run && view && <>
        <div className="detail-summary">
          <div><span>状态</span><strong>{run.status}</strong></div>
          <div><span>Run 墙钟</span><strong>{formatDuration(view.wallTimeMs)}</strong></div>
          <div><span>Trial 累计</span><strong>{formatDuration(view.aggregateTrialTimeMs)}</strong><small>并行时不等于墙钟</small></div>
          <div><span>通过</span><strong>{view.passedTrials}/{view.totalTrials || run.trialCount}</strong></div>
        </div>
        {run.error && <div className="error compact">{run.error}</div>}
        {!run.report ? <div className="detail-loading">运行尚未生成最终报告；实时事件会持续刷新。</div> : <>
          <section className="detail-section"><div className="detail-section-head"><div><span className="section-label">CONDITION SUMMARY</span><h3>条件表现</h3></div>{primaryContrast && <span className="effect-chip">{primaryContrast.left} → {primaryContrast.right} · {primaryContrast.effect === null ? "unknown" : `${primaryContrast.effect >= 0 ? "+" : ""}${(primaryContrast.effect * 100).toFixed(1)}pp`}</span>}</div><div className="condition-grid">{view.conditions.map((condition) => <div key={condition.condition}><span>{condition.condition}</span><strong>{percent(condition.successRate)}</strong><small>{condition.passed}/{condition.total} passed</small></div>)}</div></section>
          {run.report.gate && <section className="detail-section"><div className="detail-section-head"><div><span className="section-label">VALIDATION GATE</span><h3>版本门禁</h3></div><span className={`pill ${run.report.gate.status === "accept" ? "success" : run.report.gate.status === "reject" ? "danger" : "muted"}`}>{run.report.gate.status.toUpperCase()}</span></div><ul className="gate-reasons">{run.report.gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>}
          <section className="detail-section"><div className="detail-section-head"><div><span className="section-label">TRIAL EVIDENCE</span><h3>逐题结果与产物</h3></div><small>{view.trials.length} Trials</small></div><div className="trial-results">{view.trials.map((trial) => <details key={trial.trialId} className="trial-result"><summary><span className={`outcome outcome-${trial.outcome}`}>{trial.outcome}</span><b>{trial.taskId}</b><code>{trial.condition} · repeat {trial.repeatIndex}</code><time>{formatDuration(trial.durationMs)}</time></summary><div className="trial-result-body">{trial.failureReason && <p className="failure-reason">{trial.failureReason}</p>}<div><span>状态</span><code>{trial.status}</code></div><div><span>Exact match</span><code>{trial.exactMatch}</code></div>{trial.outputSha256 && <div><span>输出摘要</span><code>{trial.outputSha256}</code></div>}<pre>{trial.output ?? "没有保存输出产物"}</pre></div></details>)}</div></section>
        </>}
        <section className="detail-section"><div className="detail-section-head"><div><span className="section-label">EVENT TIMELINE</span><h3>Agent 与工具事件</h3></div><small>{view.timeline.length} events</small></div>{view.timeline.length === 0 ? <div className="detail-loading">等待平台事件…</div> : <div className="timeline">{view.timeline.map((event, index) => <details key={event.event_id ?? `${event.trial_id}-${event.seq}-${index}`} className={`timeline-event timeline-${event.category}`}><summary><time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "—"}</time><span>{event.category}</span><b>{event.label}</b><code>{event.trial_id?.split("-").slice(-4).join("-")}</code></summary><div><p>{event.detail ?? "平台未提供可展示的事件摘要"}</p><pre>{JSON.stringify(event.data, null, 2)}</pre></div></details>)}</div>}</section>
        <p className="measurement-note">耗时来自本机接收时间与执行收据；Trial 累计耗时在并发运行时不可当作 Run 总耗时。平台未报告的 token、费用或工具细节保持 unknown。</p>
      </>}
    </section>
  </div>;
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [plans, setPlans] = useState<WorkbenchPlan[]>([]);
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<WorkbenchRunDetail | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState("");
  const [compareLeftId, setCompareLeftId] = useState(() => new URL(window.location.href).searchParams.get("compareLeft") ?? "");
  const [compareRightId, setCompareRightId] = useState(() => new URL(window.location.href).searchParams.get("compareRight") ?? "");
  const [compareLeftRun, setCompareLeftRun] = useState<WorkbenchRunDetail | null>(null);
  const [compareRightRun, setCompareRightRun] = useState<WorkbenchRunDetail | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [releaseView, setReleaseView] = useState<ReleaseView | null>(null);
  const [releaseError, setReleaseError] = useState("");
  const [releaseBusy, setReleaseBusy] = useState("");
  const [exportReceipt, setExportReceipt] = useState<ExportReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [skillName, setSkillName] = useState("");
  const [targetSkillId, setTargetSkillId] = useState<string | undefined>();
  const [suiteImportOpen, setSuiteImportOpen] = useState(false);
  const [suitePath, setSuitePath] = useState("");
  const [suiteImportError, setSuiteImportError] = useState("");
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [planError, setPlanError] = useState("");
  const [planName, setPlanName] = useState("Skill effectiveness check");
  const [experimentType, setExperimentType] = useState<"trial" | "effectiveness" | "version-comparison">("effectiveness");
  const [selectedPlanSkillId, setSelectedPlanSkillId] = useState("");
  const [planSkillDetail, setPlanSkillDetail] = useState<SkillDetail | null>(null);
  const [planSkillLoading, setPlanSkillLoading] = useState(false);
  const [selectedIncumbentVersion, setSelectedIncumbentVersion] = useState("");
  const [selectedSkillVersion, setSelectedSkillVersion] = useState("");
  const [selectedSuiteVersion, setSelectedSuiteVersion] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("codex");
  const [selectedModel, setSelectedModel] = useState("default");
  const [repeats, setRepeats] = useState(1);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [concurrency, setConcurrency] = useState(1);
  const showRun = useCallback(async (runId: string, updateUrl = true) => {
    setSelectedRunId(runId);
    setRunDetail(null);
    setRunDetailLoading(true);
    setRunDetailError("");
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("run", runId);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    try { setRunDetail(await api<WorkbenchRunDetail>(`/api/v1/runs/${runId}`)); }
    catch (cause) { setRunDetailError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRunDetailLoading(false); }
  }, []);
  const closeRun = () => {
    setSelectedRunId(null);
    setRunDetail(null);
    setRunDetailError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("run");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const compareRuns = useCallback(async (leftId: string, rightId: string, updateUrl = true) => {
    if (leftId === rightId) { setComparisonError("请选择两次不同的运行"); return; }
    if (!/^run-[0-9a-f-]{36}$/.test(leftId) || !/^run-[0-9a-f-]{36}$/.test(rightId)) { setComparisonError("运行 ID 无效"); return; }
    setComparisonLoading(true);
    setComparisonError("");
    try {
      const [left, right] = await Promise.all([api<WorkbenchRunDetail>(`/api/v1/runs/${leftId}`), api<WorkbenchRunDetail>(`/api/v1/runs/${rightId}`)]);
      if (!left.report || !right.report) throw new Error("两次运行都必须完成并生成最终报告");
      setCompareLeftRun(left);
      setCompareRightRun(right);
      if (updateUrl) {
        const url = new URL(window.location.href);
        url.searchParams.delete("run");
        url.searchParams.set("compareLeft", leftId);
        url.searchParams.set("compareRight", rightId);
        url.hash = "compare";
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        setSelectedRunId(null);
        setRunDetail(null);
      }
    } catch (cause) { setComparisonError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setComparisonLoading(false); }
  }, []);
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const [workspaceResult, agentResult, skillResult, suiteResult, planResult, runResult] = await Promise.all([
        api<Workspace>("/api/v1/workspace"),
        api<{ agents: Agent[] }>(refresh ? "/api/v1/agents/refresh" : "/api/v1/agents", refresh ? { method: "POST" } : undefined),
        api<{ skills: Skill[] }>("/api/v1/skills"),
        api<{ suites: Suite[] }>("/api/v1/suites"),
        api<{ plans: WorkbenchPlan[] }>("/api/v1/plans"),
        api<{ runs: WorkbenchRun[] }>("/api/v1/runs"),
      ]);
      setWorkspace(workspaceResult);
      setAgents(agentResult.agents);
      setSkills(skillResult.skills);
      setSuites(suiteResult.suites);
      setPlans(planResult.plans);
      setRuns(runResult.runs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const requested = new URL(window.location.href).searchParams.get("run");
    if (requested && /^run-[0-9a-f-]{36}$/.test(requested) && !selectedRunId) void showRun(requested, false);
  }, [selectedRunId, showRun]);
  useEffect(() => {
    if (compareLeftId !== compareRightId && /^run-[0-9a-f-]{36}$/.test(compareLeftId) && /^run-[0-9a-f-]{36}$/.test(compareRightId) && !compareLeftRun && !compareRightRun && !comparisonLoading && !comparisonError) void compareRuns(compareLeftId, compareRightId);
  }, [compareLeftId, compareRightId, compareLeftRun, compareRightRun, comparisonLoading, comparisonError, compareRuns]);
  useEffect(() => {
    const timer = window.setInterval(() => { void api<{ runs: WorkbenchRun[] }>("/api/v1/runs").then((result) => setRuns(result.runs)).catch(() => undefined); }, 750);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!selectedRunId || !runDetail || !["queued", "running", "cancelling"].includes(runDetail.status)) return;
    const timer = window.setInterval(() => { void api<WorkbenchRunDetail>(`/api/v1/runs/${selectedRunId}`).then(setRunDetail).catch(() => undefined); }, 750);
    return () => window.clearInterval(timer);
  }, [selectedRunId, runDetail?.status]);
  const available = agents.filter((agent) => agent.installation === "found").length;
  const completedRuns = runs.filter((run) => run.status === "completed");
  useEffect(() => {
    if (!compareLeftId && !compareRightId && completedRuns.length >= 2) {
      setCompareLeftId(completedRuns[1].runId);
      setCompareRightId(completedRuns[0].runId);
    }
  }, [completedRuns, compareLeftId, compareRightId]);

  const showImport = (skill?: Skill) => {
    setTargetSkillId(skill?.skillId);
    setSourcePath(skill?.sourcePath ?? "");
    setSkillName(skill?.name ?? "");
    setImportError("");
    setImportOpen(true);
  };
  const showSkill = async (skillId: string) => {
    setError("");
    setReleaseError("");
    setExportReceipt(null);
    try {
      const [next, nextReleases] = await Promise.all([api<SkillDetail>(`/api/v1/skills/${skillId}`), api<ReleaseView>(`/api/v1/skills/${skillId}/releases`)]);
      setDetail(next);
      setReleaseView(nextReleases);
      if (next.versions.length >= 2) {
        setDiff(await api<VersionDiff>(`/api/v1/skills/${skillId}/diff?from=${encodeURIComponent(next.versions[1].versionId)}&to=${encodeURIComponent(next.versions[0].versionId)}`));
      } else setDiff(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const refreshReleases = async (skillId: string) => {
    setReleaseError("");
    try { setReleaseView(await api<ReleaseView>(`/api/v1/skills/${skillId}/releases`)); }
    catch (cause) { setReleaseError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const publishRelease = async (runId: string) => {
    if (!detail || !releaseView) return;
    setReleaseBusy(`publish:${runId}`);
    setReleaseError("");
    setExportReceipt(null);
    try {
      await api(`/api/v1/skills/${detail.skill.skillId}/releases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, expectedCurrentDigest: releaseView.currentDigest }) });
      await refreshReleases(detail.skill.skillId);
    } catch (cause) { setReleaseError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setReleaseBusy(""); }
  };
  const exportRelease = async (releaseId: string, platform: "codex" | "claude-code") => {
    if (!detail) return;
    setReleaseBusy(`export:${releaseId}:${platform}`);
    setReleaseError("");
    setExportReceipt(null);
    try {
      setExportReceipt(await api<ExportReceipt>(`/api/v1/skills/${detail.skill.skillId}/releases/${releaseId}/exports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform }) }));
    } catch (cause) { setReleaseError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setReleaseBusy(""); }
  };
  const rollbackRelease = async (item: ReleaseItem) => {
    if (!detail || !releaseView?.currentDigest || item.isCurrent) return;
    if (!window.confirm(`确认把当前发布指针回滚到 v${item.version?.ordinal ?? "?"}？历史版本和运行证据不会删除。`)) return;
    setReleaseBusy(`rollback:${item.release.release_id}`);
    setReleaseError("");
    setExportReceipt(null);
    try {
      setReleaseView(await api<ReleaseView>(`/api/v1/skills/${detail.skill.skillId}/releases/${item.release.release_id}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedCurrentDigest: releaseView.currentDigest }) }));
    } catch (cause) { setReleaseError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setReleaseBusy(""); }
  };
  const submitImport = async (event: FormEvent) => {
    event.preventDefault();
    setImporting(true);
    setImportError("");
    try {
      const result = await api<{ skill: Skill }>("/api/v1/skills/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath, name: skillName || undefined, skillId: targetSkillId }) });
      const skillResult = await api<{ skills: Skill[] }>("/api/v1/skills");
      setSkills(skillResult.skills);
      setImportOpen(false);
      await showSkill(result.skill.skillId);
    } catch (cause) { setImportError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImporting(false); }
  };
  const submitSuiteImport = async (event: FormEvent) => {
    event.preventDefault();
    setImporting(true);
    setSuiteImportError("");
    try {
      await api("/api/v1/suites/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: suitePath }) });
      setSuites((await api<{ suites: Suite[] }>("/api/v1/suites")).suites);
      setSuiteImportOpen(false);
    } catch (cause) { setSuiteImportError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImporting(false); }
  };
  const selectPlanSkill = async (skillId: string) => {
    setSelectedPlanSkillId(skillId);
    setPlanSkillDetail(null);
    setPlanSkillLoading(true);
    setPlanError("");
    try {
      const next = await api<SkillDetail>(`/api/v1/skills/${skillId}`);
      setPlanSkillDetail(next);
      setSelectedSkillVersion(next.versions[0]?.versionId ?? "");
      setSelectedIncumbentVersion(next.versions[1]?.versionId ?? "");
    } catch (cause) { setPlanError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPlanSkillLoading(false); }
  };
  const showExperiment = () => {
    const firstSkillId = skills[0]?.skillId ?? "";
    setSelectedPlanSkillId(firstSkillId);
    setPlanSkillDetail(null);
    setSelectedSkillVersion("");
    setSelectedIncumbentVersion("");
    setSelectedSuiteVersion(suites[0]?.latestVersion?.versionId ?? "");
    setSelectedAgent(agents.find((agent) => agent.installation === "found")?.id ?? "codex");
    setSelectedModel("default");
    setPlanError("");
    setExperimentOpen(true);
    if (firstSkillId) void selectPlanSkill(firstSkillId);
  };
  const submitPlan = async (event: FormEvent) => {
    event.preventDefault();
    setImporting(true);
    setPlanError("");
    try {
      await api<WorkbenchPlan>("/api/v1/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: planName, experimentType, suiteVersionId: selectedSuiteVersion, incumbentVersionId: experimentType === "version-comparison" ? selectedIncumbentVersion : undefined, candidateVersionId: selectedSkillVersion, agentId: selectedAgent, model: selectedModel, repeats, timeoutMs, concurrency }) });
      setPlans((await api<{ plans: WorkbenchPlan[] }>("/api/v1/plans")).plans);
      setExperimentOpen(false);
    } catch (cause) { setPlanError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImporting(false); }
  };
  const selectedSuite = suites.find((suite) => suite.latestVersion?.versionId === selectedSuiteVersion)?.latestVersion;
  const conditionCount = experimentType === "trial" ? 1 : experimentType === "effectiveness" ? 2 : 3;
  const previewTrials = (selectedSuite?.taskCount ?? 0) * conditionCount * repeats;
  const startRun = async (planId: string) => {
    setError("");
    try {
      const run = await api<WorkbenchRun>(`/api/v1/plans/${planId}/runs`, { method: "POST" });
      setRuns((current) => [run, ...current]);
      void showRun(run.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const cancelRun = async (runId: string) => {
    try {
      const run = await api<WorkbenchRun>(`/api/v1/runs/${runId}/cancel`, { method: "POST" });
      setRuns((current) => current.map((item) => item.runId === run.runId ? run : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const compareLeftPlan = plans.find((plan) => plan.planId === compareLeftRun?.planId);
  const compareRightPlan = plans.find((plan) => plan.planId === compareRightRun?.planId);
  const comparison = compareLeftRun && compareRightRun && compareLeftPlan && compareRightPlan ? buildRunComparison(compareLeftRun, compareRightRun, compareLeftPlan, compareRightPlan) : null;
  const comparisonLabel = comparison?.comparability === "skill-effect" ? "严格可比 · Skill 版本效果" : comparison?.comparability === "repeatability" ? "严格可比 · 相同 Skill 重复性" : "仅描述性比较";

  return <div className="shell">
    <aside>
      <div className="brand"><div className="brand-glyph">S</div><span>Skill<span>Benchmark</span></span></div>
      <nav>
        <a className="active" href="#workspace"><i>⌂</i>工作台</a>
        <a href="#skills"><i>◇</i>Skills</a>
        <a href="#suites"><i>▤</i>测试集</a>
        <a href="#experiments"><i>▶</i>实验</a>
        <a href="#compare"><i>⇄</i>对比</a>
      </nav>
      <div className="aside-bottom"><a href="#settings"><i>⚙</i>Agent 与设置</a><p>Local Workbench · v0.1</p></div>
    </aside>
    <main>
      <header><div><span className="eyebrow">LOCAL WORKSPACE</span><h1>{workspace?.name ?? "正在连接工作区"}</h1><p className="path">{workspace?.root ?? "读取启动目录…"}</p></div><span className="local-badge"><b /> 本地服务已连接</span></header>
      {error && <div className="error">{error}。请从启动命令输出的完整地址重新打开页面。</div>}
      <section className="hero">
        <div><span className="section-label">SKILL EVALUATION LAB</span><h2>让每一次 Skill 改动，<br />都有证据可循。</h2><p>导入 Skill、选择本机 Agent、运行可重复的测试，并在同一处查看过程与结果。</p><div className="actions"><button onClick={() => showImport()}>导入 Skill <span>→</span></button><button className="secondary" onClick={showExperiment} disabled={!skills.length || !suites.length || !available}>新建评测</button></div><small>{!skills.length || !suites.length ? "导入 Skill 和测试集后即可创建评测计划" : "冻结计划后可启动本机 Agent，并实时查看执行事件"}</small></div>
        <div className="orbital" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core">SB</div><span className="node n1" /><span className="node n2" /><span className="node n3" /></div>
      </section>
      <section className="metrics">
        <div><span>已导入 Skills</span><strong>{skills.length}</strong><small>{skills.length ? "版本快照已保存在当前工作区" : "等待首次导入"}</small></div>
        <div><span>可用 Agent</span><strong>{loading ? "—" : available}</strong><small>{available ? "已自动完成本机探测" : "尚未发现可用安装"}</small></div>
        <div><span>评测运行</span><strong>{runs.length}</strong><small>{runs.some((run) => ["queued", "running", "cancelling"].includes(run.status)) ? "Agent 正在执行" : runs.length ? "结果已保存在工作区" : "尚未启动运行"}</small></div>
      </section>
      <section className="skills-section" id="skills">
        <div className="section-head"><div><span className="section-label">IMMUTABLE ASSETS</span><h2>Skills 与版本</h2></div><button className="refresh" onClick={() => showImport()}>＋ 导入 Skill</button></div>
        {skills.length === 0 ? <div className="empty-state"><strong>还没有 Skill</strong><p>粘贴本机 Skill 目录，工作台会校验并保存不可变版本。</p></div> : <div className="skill-grid">
          {skills.map((skill) => <button className={`skill-card ${detail?.skill.skillId === skill.skillId ? "selected" : ""}`} key={skill.skillId} onClick={() => void showSkill(skill.skillId)}>
            <span className="skill-icon">◇</span><span className="skill-card-copy"><strong>{skill.name}</strong><small>{skill.sourcePath}</small></span><span className="version-chip">v{skill.latestVersion?.ordinal ?? 0} · {skill.versionCount} 个版本</span>
          </button>)}
        </div>}
        {detail && <div className="version-panel">
          <div className="version-panel-head"><div><span className="section-label">VERSION HISTORY</span><h3>{detail.skill.name}</h3></div><div className="version-panel-actions"><button className="secondary" onClick={() => void refreshReleases(detail.skill.skillId)}>刷新发布证据</button><button className="secondary" onClick={() => showImport(detail.skill)}>导入新版本</button></div></div>
          <div className="version-layout"><div className="version-list">{detail.versions.map((version) => <div className="version-row" key={version.versionId}><b>v{version.ordinal}</b><span><strong>{version.fileManifest.length} 个文件 {releaseView?.currentDigest === version.treeDigest && <em className="current-release-badge">CURRENT</em>}</strong><small>{version.treeDigest.slice(0, 12)} · {new Date(version.createdAt).toLocaleString()}</small></span></div>)}</div>
          <div className="diff-list"><h4>{diff ? `v${detail.versions[1]?.ordinal} → v${detail.versions[0]?.ordinal} 的变化` : "首个版本"}</h4>{diff?.files.length ? diff.files.map((file) => <div className="diff-row" key={file.path}><span className={`diff-status ${file.status}`}>{file.status === "added" ? "+" : file.status === "removed" ? "−" : "~"}</span><code>{file.path}</code><small>{file.status}</small></div>) : <p>没有可比较的历史版本。</p>}</div></div>
          <section className="release-panel">
            <div className="release-panel-head"><div><span className="section-label">EVIDENCE-BACKED RELEASES</span><h4>发布、导出与回滚</h4></div><code>{releaseView?.currentDigest ? `current ${releaseView.currentDigest.slice(0, 12)}` : "尚未发布"}</code></div>
            {releaseError && <div className="error compact">{releaseError}</div>}
            {exportReceipt && <div className="export-receipt"><span>导出完成 · {exportReceipt.platform}</span><code>{exportReceipt.output_dir}</code></div>}
            <div className="release-columns">
              <div className="eligible-releases"><h5>可发布证据</h5>{releaseView?.eligibleRuns.length ? releaseView.eligibleRuns.map((run) => <article key={run.runId}><div><strong>{run.name}</strong><small>{run.agent.name} · {run.agent.model === "default" ? "本机默认模型" : run.agent.model} · {run.suite.label}</small><code>{run.decisionId} · {run.candidateTreeDigest.slice(0, 12)}</code></div><button onClick={() => void publishRelease(run.runId)} disabled={Boolean(releaseBusy)}>{releaseBusy === `publish:${run.runId}` ? "发布中…" : "发布候选"}</button></article>) : <p>没有合格候选。只有完整且门禁为 accept 的版本对照 Run 会出现在这里。</p>}</div>
              <div className="release-history"><h5>发布历史</h5>{releaseView?.releases.length ? releaseView.releases.map((item) => <article className={item.isCurrent ? "release-current" : ""} key={item.release.release_id}><div className="release-row-head"><strong>{item.version ? `v${item.version.ordinal}` : item.release.skill_digest.slice(0, 12)}</strong><span className={`pill ${item.isCurrent ? "success" : "muted"}`}>{item.isCurrent ? "CURRENT" : "SUPERSEDED"}</span></div><small>{new Date(item.release.timestamp).toLocaleString()} · {item.release.audit_status}</small><code>{item.release.evaluation_refs.join(" · ")}</code><div className="release-actions"><button className="secondary" onClick={() => void exportRelease(item.release.release_id, "codex")} disabled={Boolean(releaseBusy)}>导出 Codex</button><button className="secondary" onClick={() => void exportRelease(item.release.release_id, "claude-code")} disabled={Boolean(releaseBusy)}>导出 Claude</button>{!item.isCurrent && <button className="rollback-button" onClick={() => void rollbackRelease(item)} disabled={Boolean(releaseBusy)}>回滚到此版本</button>}</div></article>) : <p>还没有发布记录。发布不会修改导入源目录或 Agent 的日常配置。</p>}</div>
            </div>
            {releaseView && releaseView.events.length > 0 && <p className="release-audit">审计事件 {releaseView.events.length} 条 · 最近一次：{releaseView.events.at(-1)?.event}，{new Date(releaseView.events.at(-1)!.timestamp).toLocaleString()}</p>}
          </section>
        </div>}
      </section>
      <section className="asset-section" id="suites">
        <div className="section-head"><div><span className="section-label">FROZEN TEST INPUTS</span><h2>测试集</h2></div><button className="refresh" onClick={() => { setSuitePath(""); setSuiteImportError(""); setSuiteImportOpen(true); }}>＋ 导入测试集</button></div>
        {suites.length === 0 ? <div className="empty-state"><strong>还没有测试集</strong><p>导入 Suite JSON，任务、切分和评分规则会被冻结。</p></div> : <div className="suite-grid">{suites.map((suite) => <article className="suite-card" key={suite.suiteId}><span>▤</span><div><strong>{suite.name}</strong><small>{suite.latestVersion?.taskCount ?? 0} 个任务 · v{suite.latestVersion?.ordinal ?? 0}</small></div><code>{suite.latestVersion?.digest.slice(0, 10)}</code></article>)}</div>}
      </section>
      <section className="asset-section" id="experiments">
        <div className="section-head"><div><span className="section-label">FROZEN PLANS</span><h2>评测计划</h2></div><button className="refresh" onClick={showExperiment} disabled={!skills.length || !suites.length || !available}>＋ 新建评测</button></div>
        {plans.length === 0 ? <div className="empty-state"><strong>尚未冻结计划</strong><p>选择 Skill 版本、测试集、Agent、模型与预算后预览任务矩阵。</p></div> : <div className="plan-list">{plans.map((plan) => <article className="plan-card" key={plan.planId}><div><span className="pill success">READY</span><h3>{plan.name}</h3><p>{plan.suite.label} · {plan.agent.name} {plan.agent.version ?? "unknown"} · 模型 {plan.agent.model === "default" ? "本机默认" : plan.agent.model}</p></div><div className="plan-numbers"><strong>{plan.corePlan.trials.length}</strong><small>Trials</small></div><button onClick={() => void startRun(plan.planId)}>启动运行</button></article>)}</div>}
      </section>
      <section className="asset-section" id="runs">
        <div className="section-head"><div><span className="section-label">LIVE EXECUTION</span><h2>运行监控</h2></div></div>
        {runs.length === 0 ? <div className="empty-state"><strong>还没有运行</strong><p>从已冻结计划启动，过程事件、耗时和结果会自动保存。</p></div> : <div className="run-list">{runs.map((run) => {
          const active = ["queued", "running", "cancelling"].includes(run.status);
          const progress = run.trialCount ? Math.round(run.completedTrials / run.trialCount * 100) : 0;
          const elapsedSeconds = run.startedAt ? Math.max(0, Math.round((new Date(run.finishedAt ?? Date.now()).getTime() - new Date(run.startedAt).getTime()) / 1000)) : 0;
          const runPlan = plans.find((plan) => plan.planId === run.planId);
          return <article className="run-card" key={run.runId}><div className="run-head"><div><span className={`pill run-${run.status}`}>{run.status.toUpperCase()}</span><h3>{run.name}</h3><code>{run.runId.slice(0, 18)} · {runPlan?.agent.model === "default" ? "本机默认模型" : runPlan?.agent.model ?? "未知模型"}</code></div><div className="run-count"><strong>{run.completedTrials}/{run.trialCount}</strong><small>Trials · {elapsedSeconds}s</small><div className="run-actions"><button className="secondary" onClick={() => void showRun(run.runId)}>查看详情</button>{active && <button className="danger-button" onClick={() => void cancelRun(run.runId)} disabled={run.status === "cancelling"}>{run.status === "cancelling" ? "取消中…" : "取消"}</button>}</div></div></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div>{run.error && <div className="error compact">{run.error}</div>}<div className="event-stream">{run.events.filter((item) => item.type === "trace.event").slice(-6).map((item, index) => <div key={`${item.trial_id}-${index}`}><time>{new Date(item.timestamp).toLocaleTimeString()}</time><b>{item.event?.kind ?? item.type}</b><small>{item.trial_id.split("-").slice(-4).join("-")}</small></div>)}</div></article>;
        })}</div>}
      </section>
      <section className="asset-section" id="compare">
        <div className="section-head"><div><span className="section-label">HISTORICAL COMPARISON</span><h2>历史运行对比</h2></div></div>
        {completedRuns.length < 2 ? <div className="empty-state"><strong>至少需要两次已完成运行</strong><p>完成第二次评测后，可以比较 Skill 版本、逐题变化与耗时。</p></div> : <>
          <div className="compare-controls"><label>基准运行<select value={compareLeftId} onChange={(event) => { setCompareLeftId(event.target.value); setCompareLeftRun(null); setCompareRightRun(null); setComparisonError(""); }}>{completedRuns.map((run) => <option value={run.runId} key={run.runId}>{run.name} · {new Date(run.createdAt).toLocaleString()}</option>)}</select></label><span>→</span><label>目标运行<select value={compareRightId} onChange={(event) => { setCompareRightId(event.target.value); setCompareLeftRun(null); setCompareRightRun(null); setComparisonError(""); }}>{completedRuns.map((run) => <option value={run.runId} key={run.runId}>{run.name} · {new Date(run.createdAt).toLocaleString()}</option>)}</select></label><button onClick={() => void compareRuns(compareLeftId, compareRightId)} disabled={comparisonLoading}>{comparisonLoading ? "比较中…" : "比较运行"}</button></div>
          {comparisonError && <div className="error compact">{comparisonError}</div>}
          {comparison && compareLeftRun && compareRightRun && compareLeftPlan && compareRightPlan && <div className="comparison-view">
            <div className={`comparability-banner comparison-${comparison.comparability}`}><div><span>{comparisonLabel}</span><strong>{comparison.comparability === "skill-effect" ? "配置一致，可以将配对差异解释为 Skill 快照变化的证据。" : comparison.comparability === "repeatability" ? "配置与 Skill 相同，本视图反映重复运行的稳定性。" : "配置存在差异，只能并排观察，不能将变化归因于 Skill。"}</strong></div>{comparison.reasons.length > 0 && <ul>{comparison.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>
            <div className="compare-runs"><article><span>BASELINE</span><h3>{compareLeftRun.name}</h3><p>{compareLeftPlan.agent.name} · {compareLeftPlan.agent.model === "default" ? "本机默认模型" : compareLeftPlan.agent.model}</p><code>{comparison.leftSkill?.versionId ?? "无 candidate"} · {comparison.leftSkill?.treeDigest.slice(0, 10) ?? "unknown"}</code><button className="secondary" onClick={() => void showRun(compareLeftRun.runId)}>查看证据</button></article><article><span>TARGET</span><h3>{compareRightRun.name}</h3><p>{compareRightPlan.agent.name} · {compareRightPlan.agent.model === "default" ? "本机默认模型" : compareRightPlan.agent.model}</p><code>{comparison.rightSkill?.versionId ?? "无 candidate"} · {comparison.rightSkill?.treeDigest.slice(0, 10) ?? "unknown"}</code><button className="secondary" onClick={() => void showRun(compareRightRun.runId)}>查看证据</button></article></div>
            <div className="comparison-metrics"><div className="metric-improved"><span>改进</span><strong>{comparison.counts.improved}</strong></div><div className="metric-regressed"><span>回归</span><strong>{comparison.counts.regressed}</strong></div><div><span>保持通过</span><strong>{comparison.counts.stablePass}</strong></div><div><span>缺失配对</span><strong>{comparison.counts.missing}</strong></div><div><span>墙钟变化</span><strong>{comparison.wallTimeDeltaMs === null ? "unknown" : `${comparison.wallTimeDeltaMs >= 0 ? "+" : "−"}${formatDuration(Math.abs(comparison.wallTimeDeltaMs))}`}</strong></div></div>
            <div className="condition-comparison"><h3>条件指标</h3>{comparison.conditionDeltas.map((condition) => <div key={condition.condition}><b>{condition.condition}</b><span>{percent(condition.left)}</span><i>→</i><span>{percent(condition.right)}</span><strong>{condition.delta === null ? "unknown" : `${condition.delta >= 0 ? "+" : ""}${(condition.delta * 100).toFixed(1)}pp`}</strong></div>)}</div>
            <div className="paired-results"><div className="detail-section-head"><div><span className="section-label">PAIRED RESULTS</span><h3>逐题配对变化</h3></div><small>{comparison.rows.length} pairs</small></div>{comparison.rows.map((row) => <div className={`paired-row paired-${row.change}`} key={row.key}><span>{row.change}</span><b>{row.taskId}</b><code>{row.condition} · repeat {row.repeatIndex}</code><small>{row.leftOutcome ?? "missing"} → {row.rightOutcome ?? "missing"}</small></div>)}</div>
            <p className="measurement-note">配对键为 task、profile、condition 和 repeat。描述性比较会保留观察到的改进/回归，但不会生成 Skill 因果结论。</p>
          </div>}
        </>}
      </section>
      <section className="agents">
        <div className="section-head"><div><span className="section-label">LOCAL AGENTS</span><h2>本机 Agent</h2></div><button className="refresh" onClick={() => void load(true)} disabled={loading}>{loading ? "探测中…" : "↻ 重新探测"}</button></div>
        <div className="agent-grid">{agents.map((agent) => <AgentCard agent={agent} key={agent.id} />)}</div>
        <p className="notice">探测只检查本机可执行文件和版本，不会读取或保存登录凭证。连接资格会在真实运行前单独验证。</p>
      </section>
    </main>
    {selectedRunId && <RunDetailModal run={runDetail} plan={plans.find((plan) => plan.planId === runDetail?.planId)} loading={runDetailLoading} error={runDetailError} onClose={closeRun} />}
    {importOpen && <div className="modal-backdrop" role="presentation"><form className="import-modal" onSubmit={(event) => void submitImport(event)}>
      <div className="modal-head"><div><span className="section-label">{targetSkillId ? "NEW VERSION" : "IMPORT SKILL"}</span><h2>{targetSkillId ? "导入新版本" : "导入本机 Skill"}</h2></div><button type="button" className="modal-close" aria-label="关闭" onClick={() => setImportOpen(false)}>×</button></div>
      <label>Skill 目录路径<input autoFocus value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/Users/you/skills/my-skill" /></label>
      <label>显示名称 <small>可选，默认读取 SKILL.md 标题</small><input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="例如：代码审查 Skill" /></label>
      <div className="import-notes"><span>✓ 不执行目录内脚本</span><span>✓ 拒绝越界符号链接</span><span>✓ 原目录保持不变</span></div>
      {importError && <div className="error compact">{importError}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setImportOpen(false)}>取消</button><button type="submit" disabled={importing || !sourcePath.trim()}>{importing ? "正在建立快照…" : targetSkillId ? "保存新版本" : "导入并保存"}</button></div>
    </form></div>}
    {suiteImportOpen && <div className="modal-backdrop" role="presentation"><form className="import-modal" onSubmit={(event) => void submitSuiteImport(event)}>
      <div className="modal-head"><div><span className="section-label">IMPORT SUITE</span><h2>导入测试集</h2></div><button type="button" className="modal-close" aria-label="关闭" onClick={() => setSuiteImportOpen(false)}>×</button></div>
      <label>Suite JSON 路径<input autoFocus value={suitePath} onChange={(event) => setSuitePath(event.target.value)} placeholder="/Users/you/project/suites/smoke.json" /></label>
      <div className="import-notes"><span>✓ 校验任务 ID</span><span>✓ 检查 split 泄漏</span><span>✓ 冻结内容摘要</span></div>
      {suiteImportError && <div className="error compact">{suiteImportError}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setSuiteImportOpen(false)}>取消</button><button type="submit" disabled={importing || !suitePath.trim()}>{importing ? "正在校验…" : "导入并冻结"}</button></div>
    </form></div>}
    {experimentOpen && <div className="modal-backdrop" role="presentation"><form className="import-modal plan-modal" onSubmit={(event) => void submitPlan(event)}>
      <div className="modal-head"><div><span className="section-label">NEW EVALUATION</span><h2>冻结评测计划</h2></div><button type="button" className="modal-close" aria-label="关闭" onClick={() => setExperimentOpen(false)}>×</button></div>
      <div className="form-grid"><label className="wide">计划名称<input value={planName} onChange={(event) => setPlanName(event.target.value)} /></label>
      <label>实验类型<select value={experimentType} onChange={(event) => setExperimentType(event.target.value as "trial" | "effectiveness" | "version-comparison")}><option value="effectiveness">有效性对照</option><option value="version-comparison">版本对照</option><option value="trial">单版本试跑</option></select></label>
      <label>Skill<select value={selectedPlanSkillId} onChange={(event) => void selectPlanSkill(event.target.value)}>{skills.map((skill) => <option value={skill.skillId} key={skill.skillId}>{skill.name} · {skill.versionCount} 个版本</option>)}</select></label>
      <label>候选版本<select value={selectedSkillVersion} disabled={planSkillLoading} onChange={(event) => { const versionId = event.target.value; setSelectedSkillVersion(versionId); if (selectedIncumbentVersion === versionId) setSelectedIncumbentVersion(planSkillDetail?.versions.find((version) => version.versionId !== versionId)?.versionId ?? ""); }}>{planSkillDetail?.versions.map((version) => <option value={version.versionId} key={version.versionId}>v{version.ordinal} · {version.treeDigest.slice(0, 10)}</option>)}</select></label>
      {experimentType === "version-comparison" && <label>基准版本<select value={selectedIncumbentVersion} disabled={planSkillLoading} onChange={(event) => setSelectedIncumbentVersion(event.target.value)}>{planSkillDetail?.versions.filter((version) => version.versionId !== selectedSkillVersion).map((version) => <option value={version.versionId} key={version.versionId}>v{version.ordinal} · {version.treeDigest.slice(0, 10)}</option>)}</select><small>{planSkillDetail && planSkillDetail.versions.length < 2 ? "该 Skill 至少需要两个不可变版本" : "同一次运行中作为 incumbent 对照"}</small></label>}
      <label>测试集<select value={selectedSuiteVersion} onChange={(event) => setSelectedSuiteVersion(event.target.value)}>{suites.map((suite) => suite.latestVersion && <option value={suite.latestVersion.versionId} key={suite.suiteId}>{suite.name} · v{suite.latestVersion.ordinal}</option>)}</select></label>
      <label>执行 Agent<select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>{agents.filter((agent) => agent.installation === "found").map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.version}</option>)}</select></label>
      <label>测试模型 <small>default 跟随本机 CLI 默认；也可填写该 Agent 支持的模型 ID</small><input value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} placeholder="default" /></label>
      <label>重复次数<input type="number" min="1" max="10" value={repeats} onChange={(event) => setRepeats(Number(event.target.value))} /></label>
      <label>单题超时（秒）<input type="number" min="1" max="3600" value={timeoutMs / 1000} onChange={(event) => setTimeoutMs(Number(event.target.value) * 1000)} /></label>
      <label>并发数<input type="number" min="1" max="4" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label></div>
      <div className="plan-preview"><span>计划预览</span><strong>{previewTrials} 个 Trial</strong><p>{selectedSuite?.taskCount ?? 0} 个任务 × {conditionCount} 个条件 × {repeats} 次重复 · 模型 {selectedModel.trim() === "default" || !selectedModel.trim() ? "本机默认" : selectedModel.trim()}</p><small>{experimentType === "version-comparison" ? "none、incumbent、candidate 会从各自冻结版本执行；版本增益与回归门禁保存在最终报告。" : "模型会写入比较指纹；不同模型的运行只能做描述性并排，不能直接归因于 Skill。"}</small></div>
      {planError && <div className="error compact">{planError}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setExperimentOpen(false)}>取消</button><button type="submit" disabled={importing || planSkillLoading || !selectedSkillVersion || !selectedSuiteVersion || (experimentType === "version-comparison" && !selectedIncumbentVersion)}>{importing ? "正在冻结…" : "确认并冻结计划"}</button></div>
    </form></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
