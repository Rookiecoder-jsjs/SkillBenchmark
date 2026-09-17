# 跨平台插件与执行器

状态：首版 Adapter、统一收据与能力矩阵已实现，真实平台完整一致性验证仍待目标 Worker 实测。核对时间：2026-09-17。已验证官方文档、本机 CLI 帮助和双平台 fake CLI 事件夹具。

## 1. 兼容性分层

“跨平台”有三个层面，分别标记支持程度：

1. Skill 内容兼容：标准包能被解析和导入。
2. 评测操作兼容：用户能从不同宿主提交同一个实验。
3. 执行与观测兼容：被测平台能按协议执行、提供足够证据并满足隔离要求。

每个 Adapter 返回能力报告。支持 SKILL.md 不意味着支持自动启动、完整事件、费用统计、原生触发观测或热更新。

## 2. 共用的 Skill 包

Agent Skills 使用带 SKILL.md 的目录，并允许附带脚本、参考材料和资源。[官方格式规范](https://agentskills.io/specification)

导入时保持原始包字节和行为。平台专属 frontmatter/工具依赖进入兼容性诊断；不静默删除字段或重写工具名称。确需转换时生成单独的衍生快照，报告其差异，并分别评测。

评测数据、隐藏答案和改进 Wiki 均通过 sidecar/控制层管理，不作为被测 Skill 的参考文件。

## 3. 操作插件

两个插件包分别适配各自清单，复用一组管理工作流：

| 工作流 | 用户意图 | 调用 |
| --- | --- | --- |
| evaluate | 测这个 Skill | import → plan → submit |
| report | 查看效果与失败 | getRun → compareRun |
| evolve | 基于训练证据提出改进 | evolve → getProposal |
| publish | 发布评测通过的版本 | publishRelease |

用户传入 Skill 目录、Suite 和 Profile；没有 Suite 时，引导选择模板或生成任务草案，并先校验评分依据。不能仅阅读 SKILL.md 就给出“有效性分数”。

管理插件发起的子实验必须创建全新被测会话，不继承当前对话。对话中展示的是 Run ID、进度和报告，批量任务不要求宿主持续在线等待。

v0.1 CLI 是完整入口；`apps/mcp-server` 已提供同一组核心操作的 JSON-RPC 桥接，`plugins/codex` 与 `plugins/claude-code` 提供清单。MCP 工具名称、slash 命令名称和插件缓存加载行为仍需按宿主平台版本确认。

## 4. 首批执行入口

| 能力 | Codex | Claude Code |
| --- | --- | --- |
| 非交互入口 | `codex exec` | `claude -p` |
| 机器可读输出 | `--json` | `--output-format stream-json --verbose` |
| 模型选择 | 本机帮助有 `--model` | 本机帮助有 `--model` |
| 会话持久化控制 | 本机帮助有 `--ephemeral` | 本机帮助有 `--no-session-persistence` |
| 单次插件加载 | 需要 Adapter 单独验证机制 | 本机帮助有 `--plugin-dir` |
| 禁止外部配置污染 | 需要环境级隔离验证 | 需要环境级隔离验证 |
| 强制 system 级 Skill 注入 | 不假定支持任意等价覆盖 | 有附加 system prompt 入口，但不认为与 Codex 等价 |
| 原生触发观测 | 待实测 | 待实测 |

非交互与结构化输出见 [Codex 官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)和 [Claude Code 官方文档](https://code.claude.com/docs/en/headless)。其余 flags 的本机检查结果见[来源记录](sources.md)。

本机存在忽略部分配置的参数，但单个参数不能证明全部记忆、Skill、项目指令和内建行为已移除。Adapter 要生成实际配置收据，隔离后端要验证可访问范围。

## 5. Skill 加载

### controlled

v0.1 优先验证两端均能实现的 `explicit-file-read`：固定公开包路径和中性加载指令，Skill 各版本保持相同路径；工具读到正文是加载证据。none 不包含目标包，也不要求读取它。加载差异属于待测干预的一部分。

对于仅正文的 Skill，可以另设 `prompt-inline` 实验；记录实际角色、位置和拼接模板摘要。它与文件读取结果分开。无法在两端做到相同 system 角色时，不称作论文的完全相同注入实验。

注入正文、挂载资源和原生安装分别记录。即使正文成功加载，也可能漏读脚本或引用材料，这些作为执行诊断。

### native

按平台支持的原生机制加载插件/Skill，保持任务提示中不包含触发暗示。正例测漏触发，负例测误触发。请求原生模式而平台能力未验证时，Adapter/调度器返回 unsupported 或 exploratory；不能静默改成全文注入。当前 Claude Adapter 通过 `--plugin-dir` 传递 native Skill，Codex Adapter 明确不声明 native 支持。

## 6. Adapter 一致性检查

正式成绩前，至少验证：

- 能返回结构化终态，异常退出不会当成通过。
- 指定任务目录之外的前一次产物、Wiki 和隐藏评分器不可访问。
- none/当前/候选能加载预期包，摘要与资源一致。
- 两次任务会话独立，用户级配置污染检测通过。
- 模型或配置静默回退能被检测或明确标记；未知模型版本进入限制说明。
- 工具结果与产物能交给外部评分器；缺失字段保留 unknown。
- 取消能终止整个受管进程树；超时和基础设施错误正确分类。
- 不支持的预算约束明确返回 unsupported，不能显示成已强制执行。

测试矩阵以 `Adapter 版本 × 平台版本 × OS/Worker × 加载方式` 为单位。macOS、Windows 可作为控制端；正式 Worker 初期建议统一一个经过验证的 Linux 环境组合，以降低操作系统差异。其他 Worker 是后续逐项适配目标。

## 7. 预算与认证

每次 plan 先给出 Trial 数量、单次 `timeout_ms`、整体 `max_duration_ms` 和调用上限。平台支持的 Token 或费用上限可映射为原生参数；不支持时采用已验证的外部计量/终止机制，仍无法强制的约束直接拒绝该配置。Runner/Grader 的输出捕获超过固定上限时终止该尝试，避免异常 CLI 占满内存。

费用不可观测时显示 unknown；用量估算单独注明。Optimizer 的模型调用也计入整轮演化成本，不只统计被测 Agent。

认证使用平台支持的非交互路径，凭证由执行环境配置，不写入 Skill、Suite、RunPlan 或日志。能调用已登录 CLI 不代表订阅凭证能被当成独立 API key，Adapter 不作这种转换。

工作台的“验证连接”是显式、小预算真实调用：固定要求返回一个常量，不读取 Skill 或项目文件，在 Workspace 下的临时目录运行，并限制超时、输出和同 Agent 并发。Claude Code 额外限制单轮、预算和工具；Codex 使用只读 sandbox。验证记录只保存终态、请求/实际模型、会话和平台报告的用量，不保存凭证或原始事件。成功仅证明当前认证和结构化结果可用，不能替代一致性矩阵，因此 `evaluationSupport` 保持 `exploratory`。

能力矩阵把本机探测、连接验证和 Adapter 自动化夹具分开。Codex 夹具覆盖 `thread.started`、`item.*`、`turn.completed`、`turn.failed` 与用量；Claude 夹具覆盖 system init、assistant/tool_use、result、会话、模型、用量与费用。当前 Codex JSONL 未保证报告实际模型时，模型收据显示 `not-reported`，不会用请求模型冒充实际模型。连接验证禁用工具，因此没有工具事件只保留 exploratory，不判定 unsupported。

## 8. 可比性与降级

`verified` 表示已经通过对应矩阵的一致性检查；`exploratory` 表示可以调试但证据不足；`unsupported` 表示不能实现指定实验。降级要改变 Run 标签并让用户在计划中看见，不能在执行时悄悄混入正式成绩。

新增平台主要实现 Adapter、平台插件包装和一致性测试。领域任务与评分器复用；平台特有工作流可以单独测试，但不承诺所有 Skill 在所有平台行为相同。
