import { StrictMode, useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
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
interface WorkbenchPlan { planId: string; name: string; experimentType: "trial" | "effectiveness"; status: "ready"; createdAt: string; planDigest: string; suite: { suiteId: string; versionId: string; digest: string; label: string; taskCount: number }; agent: { id: string; name: string; version: string | null; evaluationSupport: string; model: string }; bindings: { candidate?: { versionId: string; treeDigest: string } }; corePlan: { trials: unknown[]; conditions: string[]; repeats: number; budget: { timeout_ms: number; concurrency: number } } }
interface RunProgress { type: "trial.running" | "trace.event" | "trial.finished"; trial_id: string; timestamp: string; status?: string; event?: { kind: string; producer: string; data: Record<string, unknown> } }
interface WorkbenchRun { runId: string; planId: string; name: string; status: "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed"; createdAt: string; startedAt: string | null; finishedAt: string | null; trialCount: number; completedTrials: number; trialStatuses: Record<string, string>; events: RunProgress[]; error: string | null }

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

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [plans, setPlans] = useState<WorkbenchPlan[]>([]);
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
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
  const [experimentType, setExperimentType] = useState<"trial" | "effectiveness">("effectiveness");
  const [selectedSkillVersion, setSelectedSkillVersion] = useState("");
  const [selectedSuiteVersion, setSelectedSuiteVersion] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("codex");
  const [selectedModel, setSelectedModel] = useState("default");
  const [repeats, setRepeats] = useState(1);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [concurrency, setConcurrency] = useState(1);
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
    const timer = window.setInterval(() => { void api<{ runs: WorkbenchRun[] }>("/api/v1/runs").then((result) => setRuns(result.runs)).catch(() => undefined); }, 750);
    return () => window.clearInterval(timer);
  }, []);
  const available = agents.filter((agent) => agent.installation === "found").length;

  const showImport = (skill?: Skill) => {
    setTargetSkillId(skill?.skillId);
    setSourcePath(skill?.sourcePath ?? "");
    setSkillName(skill?.name ?? "");
    setImportError("");
    setImportOpen(true);
  };
  const showSkill = async (skillId: string) => {
    setError("");
    try {
      const next = await api<SkillDetail>(`/api/v1/skills/${skillId}`);
      setDetail(next);
      if (next.versions.length >= 2) {
        setDiff(await api<VersionDiff>(`/api/v1/skills/${skillId}/diff?from=${encodeURIComponent(next.versions[1].versionId)}&to=${encodeURIComponent(next.versions[0].versionId)}`));
      } else setDiff(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
  const showExperiment = () => {
    setSelectedSkillVersion(skills[0]?.latestVersion?.versionId ?? "");
    setSelectedSuiteVersion(suites[0]?.latestVersion?.versionId ?? "");
    setSelectedAgent(agents.find((agent) => agent.installation === "found")?.id ?? "codex");
    setSelectedModel("default");
    setPlanError("");
    setExperimentOpen(true);
  };
  const submitPlan = async (event: FormEvent) => {
    event.preventDefault();
    setImporting(true);
    setPlanError("");
    try {
      await api<WorkbenchPlan>("/api/v1/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: planName, experimentType, suiteVersionId: selectedSuiteVersion, candidateVersionId: selectedSkillVersion, agentId: selectedAgent, model: selectedModel, repeats, timeoutMs, concurrency }) });
      setPlans((await api<{ plans: WorkbenchPlan[] }>("/api/v1/plans")).plans);
      setExperimentOpen(false);
    } catch (cause) { setPlanError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImporting(false); }
  };
  const selectedSuite = suites.find((suite) => suite.latestVersion?.versionId === selectedSuiteVersion)?.latestVersion;
  const previewTrials = (selectedSuite?.taskCount ?? 0) * (experimentType === "effectiveness" ? 2 : 1) * repeats;
  const startRun = async (planId: string) => {
    setError("");
    try {
      const run = await api<WorkbenchRun>(`/api/v1/plans/${planId}/runs`, { method: "POST" });
      setRuns((current) => [run, ...current]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const cancelRun = async (runId: string) => {
    try {
      const run = await api<WorkbenchRun>(`/api/v1/runs/${runId}/cancel`, { method: "POST" });
      setRuns((current) => current.map((item) => item.runId === run.runId ? run : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

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
          <div className="version-panel-head"><div><span className="section-label">VERSION HISTORY</span><h3>{detail.skill.name}</h3></div><button className="secondary" onClick={() => showImport(detail.skill)}>导入新版本</button></div>
          <div className="version-layout"><div className="version-list">{detail.versions.map((version) => <div className="version-row" key={version.versionId}><b>v{version.ordinal}</b><span><strong>{version.fileManifest.length} 个文件</strong><small>{version.treeDigest.slice(0, 12)} · {new Date(version.createdAt).toLocaleString()}</small></span></div>)}</div>
          <div className="diff-list"><h4>{diff ? `v${detail.versions[1]?.ordinal} → v${detail.versions[0]?.ordinal} 的变化` : "首个版本"}</h4>{diff?.files.length ? diff.files.map((file) => <div className="diff-row" key={file.path}><span className={`diff-status ${file.status}`}>{file.status === "added" ? "+" : file.status === "removed" ? "−" : "~"}</span><code>{file.path}</code><small>{file.status}</small></div>) : <p>没有可比较的历史版本。</p>}</div></div>
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
          return <article className="run-card" key={run.runId}><div className="run-head"><div><span className={`pill run-${run.status}`}>{run.status.toUpperCase()}</span><h3>{run.name}</h3><code>{run.runId.slice(0, 18)} · {runPlan?.agent.model === "default" ? "本机默认模型" : runPlan?.agent.model ?? "未知模型"}</code></div><div className="run-count"><strong>{run.completedTrials}/{run.trialCount}</strong><small>Trials · {elapsedSeconds}s</small>{active && <button className="danger-button" onClick={() => void cancelRun(run.runId)} disabled={run.status === "cancelling"}>{run.status === "cancelling" ? "取消中…" : "取消"}</button>}</div></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div>{run.error && <div className="error compact">{run.error}</div>}<div className="event-stream">{run.events.filter((item) => item.type === "trace.event").slice(-6).map((item, index) => <div key={`${item.trial_id}-${index}`}><time>{new Date(item.timestamp).toLocaleTimeString()}</time><b>{item.event?.kind ?? item.type}</b><small>{item.trial_id.split("-").slice(-4).join("-")}</small></div>)}</div></article>;
        })}</div>}
      </section>
      <section className="agents">
        <div className="section-head"><div><span className="section-label">LOCAL AGENTS</span><h2>本机 Agent</h2></div><button className="refresh" onClick={() => void load(true)} disabled={loading}>{loading ? "探测中…" : "↻ 重新探测"}</button></div>
        <div className="agent-grid">{agents.map((agent) => <AgentCard agent={agent} key={agent.id} />)}</div>
        <p className="notice">探测只检查本机可执行文件和版本，不会读取或保存登录凭证。连接资格会在真实运行前单独验证。</p>
      </section>
    </main>
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
      <label>实验类型<select value={experimentType} onChange={(event) => setExperimentType(event.target.value as "trial" | "effectiveness")}><option value="effectiveness">有效性对照</option><option value="trial">单版本试跑</option></select></label>
      <label>Skill 版本<select value={selectedSkillVersion} onChange={(event) => setSelectedSkillVersion(event.target.value)}>{skills.map((skill) => skill.latestVersion && <option value={skill.latestVersion.versionId} key={skill.skillId}>{skill.name} · v{skill.latestVersion.ordinal}</option>)}</select></label>
      <label>测试集<select value={selectedSuiteVersion} onChange={(event) => setSelectedSuiteVersion(event.target.value)}>{suites.map((suite) => suite.latestVersion && <option value={suite.latestVersion.versionId} key={suite.suiteId}>{suite.name} · v{suite.latestVersion.ordinal}</option>)}</select></label>
      <label>执行 Agent<select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>{agents.filter((agent) => agent.installation === "found").map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.version}</option>)}</select></label>
      <label>测试模型 <small>default 跟随本机 CLI 默认；也可填写该 Agent 支持的模型 ID</small><input value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} placeholder="default" /></label>
      <label>重复次数<input type="number" min="1" max="10" value={repeats} onChange={(event) => setRepeats(Number(event.target.value))} /></label>
      <label>单题超时（秒）<input type="number" min="1" max="3600" value={timeoutMs / 1000} onChange={(event) => setTimeoutMs(Number(event.target.value) * 1000)} /></label>
      <label>并发数<input type="number" min="1" max="4" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label></div>
      <div className="plan-preview"><span>计划预览</span><strong>{previewTrials} 个 Trial</strong><p>{selectedSuite?.taskCount ?? 0} 个任务 × {experimentType === "effectiveness" ? "2 个条件" : "1 个条件"} × {repeats} 次重复 · 模型 {selectedModel.trim() === "default" || !selectedModel.trim() ? "本机默认" : selectedModel.trim()}</p><small>模型会写入比较指纹；不同模型的运行只能做描述性并排，不能直接归因于 Skill。</small></div>
      {planError && <div className="error compact">{planError}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setExperimentOpen(false)}>取消</button><button type="submit" disabled={importing || !selectedSkillVersion || !selectedSuiteVersion}>{importing ? "正在冻结…" : "确认并冻结计划"}</button></div>
    </form></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
