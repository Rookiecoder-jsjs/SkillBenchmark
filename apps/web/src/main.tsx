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
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const [workspaceResult, agentResult, skillResult] = await Promise.all([
        api<Workspace>("/api/v1/workspace"),
        api<{ agents: Agent[] }>(refresh ? "/api/v1/agents/refresh" : "/api/v1/agents", refresh ? { method: "POST" } : undefined),
        api<{ skills: Skill[] }>("/api/v1/skills"),
      ]);
      setWorkspace(workspaceResult);
      setAgents(agentResult.agents);
      setSkills(skillResult.skills);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
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
        <div><span className="section-label">SKILL EVALUATION LAB</span><h2>让每一次 Skill 改动，<br />都有证据可循。</h2><p>导入 Skill、选择本机 Agent、运行可重复的测试，并在同一处查看过程与结果。</p><div className="actions"><button onClick={() => showImport()}>导入 Skill <span>→</span></button><button className="secondary" disabled>新建评测</button></div><small>导入只建立不可变快照，不会修改原目录</small></div>
        <div className="orbital" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core">SB</div><span className="node n1" /><span className="node n2" /><span className="node n3" /></div>
      </section>
      <section className="metrics">
        <div><span>已导入 Skills</span><strong>{skills.length}</strong><small>{skills.length ? "版本快照已保存在当前工作区" : "等待首次导入"}</small></div>
        <div><span>可用 Agent</span><strong>{loading ? "—" : available}</strong><small>{available ? "已自动完成本机探测" : "尚未发现可用安装"}</small></div>
        <div><span>历史运行</span><strong>0</strong><small>运行结果将自动保存</small></div>
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
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
