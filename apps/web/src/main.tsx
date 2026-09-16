import { StrictMode, useCallback, useEffect, useState } from "react";
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`请求失败（${response.status}）`);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const [workspaceResult, agentResult] = await Promise.all([
        api<Workspace>("/api/v1/workspace"),
        api<{ agents: Agent[] }>(refresh ? "/api/v1/agents/refresh" : "/api/v1/agents", refresh ? { method: "POST" } : undefined),
      ]);
      setWorkspace(workspaceResult);
      setAgents(agentResult.agents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const available = agents.filter((agent) => agent.installation === "found").length;

  return <div className="shell">
    <aside>
      <div className="brand"><div className="brand-glyph">S</div><span>Skill<span>Benchmark</span></span></div>
      <nav>
        <a className="active" href="#workspace"><i>⌂</i>工作台</a>
        <a href="#skills"><i>◇</i>Skills <em>下一阶段</em></a>
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
        <div><span className="section-label">SKILL EVALUATION LAB</span><h2>让每一次 Skill 改动，<br />都有证据可循。</h2><p>导入 Skill、选择本机 Agent、运行可重复的测试，并在同一处查看过程与结果。</p><div className="actions"><button disabled>导入第一个 Skill <span>→</span></button><button className="secondary" disabled>新建评测</button></div><small>Skill 导入将在下一切片接通</small></div>
        <div className="orbital" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core">SB</div><span className="node n1" /><span className="node n2" /><span className="node n3" /></div>
      </section>
      <section className="metrics">
        <div><span>已导入 Skills</span><strong>0</strong><small>等待首次导入</small></div>
        <div><span>可用 Agent</span><strong>{loading ? "—" : available}</strong><small>{available ? "已自动完成本机探测" : "尚未发现可用安装"}</small></div>
        <div><span>历史运行</span><strong>0</strong><small>运行结果将自动保存</small></div>
      </section>
      <section className="agents">
        <div className="section-head"><div><span className="section-label">LOCAL AGENTS</span><h2>本机 Agent</h2></div><button className="refresh" onClick={() => void load(true)} disabled={loading}>{loading ? "探测中…" : "↻ 重新探测"}</button></div>
        <div className="agent-grid">{agents.map((agent) => <AgentCard agent={agent} key={agent.id} />)}</div>
        <p className="notice">探测只检查本机可执行文件和版本，不会读取或保存登录凭证。连接资格会在真实运行前单独验证。</p>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
