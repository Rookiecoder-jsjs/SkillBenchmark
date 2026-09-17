import type { AgentDiscovery } from "./discovery.ts";

export type AgentCapabilityStatus = "verified" | "exploratory" | "not-reported" | "unsupported";
export type AgentCapabilitySource = "discovery" | "connection" | "adapter-conformance";

export interface AgentCapabilityEvidence {
  id: "launch" | "authentication" | "structured-output" | "isolated-workspace" | "session-receipt" | "model-receipt" | "usage-receipt" | "cost-receipt" | "tool-events" | "timeout-control" | "cancellation-control";
  label: string;
  status: AgentCapabilityStatus;
  source: AgentCapabilitySource;
  observedAt: string | null;
  detail: string;
}

interface VerificationEvidence {
  status: "queued" | "running" | "succeeded" | "failed";
  finishedAt: string | null;
  authentication: "unknown" | "ready" | "required" | "failed";
  checks: { exactOutput: boolean; structuredResult: boolean; isolatedWorkspace: boolean; toolEvents?: boolean };
  receipt: { requested_model?: string; reported_model: string | null; session_id: string | null; input_tokens: number | null; output_tokens: number | null; estimated_cost: number | null } | null;
  error: string | null;
}

function connectionCapability(id: AgentCapabilityEvidence["id"], label: string, verification: VerificationEvidence | null, observed: boolean, missingDetail: string): AgentCapabilityEvidence {
  if (!verification || verification.status === "queued" || verification.status === "running") {
    return { id, label, status: "exploratory", source: "connection", observedAt: null, detail: "尚未完成连接验证" };
  }
  if (observed) return { id, label, status: "verified", source: "connection", observedAt: verification.finishedAt, detail: "最近一次连接验证提供了直接证据" };
  if (verification.status === "succeeded") return { id, label, status: "not-reported", source: "connection", observedAt: verification.finishedAt, detail: missingDetail };
  return { id, label, status: "exploratory", source: "connection", observedAt: verification.finishedAt, detail: verification.error ?? "连接验证未完成该项检查" };
}

export function buildAgentCapabilityMatrix(agent: AgentDiscovery, verification: VerificationEvidence | null): AgentCapabilityEvidence[] {
  const installed = agent.installation === "found";
  const observedAt = agent.detectedAt || null;
  const receipt = verification?.receipt;
  const inputOrOutputUsage = receipt?.input_tokens !== null && receipt?.input_tokens !== undefined || receipt?.output_tokens !== null && receipt?.output_tokens !== undefined;
  return [
    { id: "launch", label: "可执行文件启动", status: installed ? "verified" : "unsupported", source: "discovery", observedAt, detail: installed ? `已启动版本探测：${agent.version ?? "版本未知"}` : agent.evidence[0] ?? "未发现可执行文件" },
    { id: "authentication", label: "本机登录可用", status: verification?.authentication === "ready" ? "verified" : verification?.authentication === "required" || verification?.authentication === "failed" ? "unsupported" : "exploratory", source: "connection", observedAt: verification?.finishedAt ?? null, detail: verification?.authentication === "ready" ? "最近一次连接验证成功" : verification?.authentication === "required" ? "需要先完成平台登录" : verification?.error ?? "尚未验证登录状态" },
    connectionCapability("structured-output", "结构化终态", verification, Boolean(verification?.checks.structuredResult && verification?.checks.exactOutput), "平台未返回可确认的结构化终态"),
    connectionCapability("isolated-workspace", "隔离工作目录", verification, Boolean(verification?.checks.isolatedWorkspace), "连接验证未确认隔离工作目录"),
    connectionCapability("session-receipt", "会话标识收据", verification, Boolean(receipt?.session_id), "平台在本次连接中未报告会话标识"),
    connectionCapability("model-receipt", "实际模型收据", verification, Boolean(receipt?.reported_model), agent.id === "codex" ? "当前 Codex JSONL 未报告实际模型，保留 unknown" : "平台在本次连接中未报告实际模型"),
    connectionCapability("usage-receipt", "Token 用量收据", verification, Boolean(inputOrOutputUsage), "平台在本次连接中未报告 Token 用量"),
    connectionCapability("cost-receipt", "费用收据", verification, receipt?.estimated_cost !== null && receipt?.estimated_cost !== undefined, "平台在本次连接中未报告费用；不能解释为零费用"),
    verification?.checks.toolEvents
      ? { id: "tool-events", label: "工具事件", status: "verified", source: "connection", observedAt: verification.finishedAt, detail: "最近一次验证观察到平台工具事件" }
      : { id: "tool-events", label: "工具事件", status: "exploratory", source: "connection", observedAt: verification?.finishedAt ?? null, detail: "最小连接验证禁用工具，不据此判断本机工具事件能力" },
    { id: "timeout-control", label: "超时终止", status: "verified", source: "adapter-conformance", observedAt: null, detail: "Adapter 自动化测试已覆盖；不代表当前本机 CLI 已实测" },
    { id: "cancellation-control", label: "取消与进程清理", status: "verified", source: "adapter-conformance", observedAt: null, detail: "Adapter 自动化测试已覆盖；不代表当前本机 CLI 已实测" },
  ];
}
