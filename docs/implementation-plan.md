# 实施计划与验收

状态：P0-P4 首版工程链路已实现，真实平台和生产隔离验证待在目标 Worker 上执行。按可验证的交付物推进；阶段序号不等于固定工期。

下一阶段按[本地可视化工作台架构](local-workbench-architecture.md)中的 W1–W4 推进：工作台与资产 → Codex 实时运行 → 对比与版本管理 → Claude Code 一致性验证。以下 P0–P4 是已有首版模块的工程记录，不能视为新工作台或真实多版本演化已经完成；必要改造见新架构第 12 节。

W1 前三条竖切片已实现：`npm run dev`/`ui` 启动回环地址上的 React 工作台，保留启动 Workspace，展示有界的 Codex/Claude Code 安装与版本探测，并使用启动令牌、Host/Origin 校验和安全响应头保护本地 API。Skill 目录可导入为稳定身份下的不可变版本，文件对象按摘要保存，支持重复内容去重、版本历史和文件级 diff；Suite 可校验并冻结为不可变版本，评测计划会绑定精确的 Suite、Skill、Agent、条件和预算。真实 Agent 执行及实时事件属于 W2。

W2 首条竖切片已实现：运行服务从冻结计划生成独立 Run，按条件放置精确 SkillVersion，通过现有 Codex/Claude Adapter 和临时环境执行，增量保存 Trial/平台事件，支持超时、输出上限、AbortSignal 取消与子进程树清理。工作台轮询显示进度和事件，刷新后恢复历史。当前自动化与浏览器验收使用 fake Codex；真实账号、认证和固定模型下的一致性验证仍待小预算实测。

## 当前实现进度

已落地本地可验证闭环：

- `packages/contracts` 提供 v0.1 的领域类型与 SkillSnapshot、SuiteSnapshot、RunPlan、Trial、Grade、Comparison JSON Schema。
- `packages/core` 提供 Skill 目录快照、Suite 导入与切分检查、计划展开、确定性 mock Runner、exact-match Grader、外部 Grader 进程接口和 JSON/Markdown/HTML 报告。
- `apps/cli` 提供 `plan`、`run`、`snapshot` 和内置 `demo` 命令。
- `packages/core` 的 SQLite 索引保存 Run、Trial、事件、Grade、比较/决策和对象元数据；相同 Run 可从已完成 Trial 恢复，避免重复事件。
- P1 已实现本地临时 EnvironmentBackend、内容寻址对象存储、受管子进程、超时/基础设施错误分类、并发调度和基础设施重试；Codex/Claude Adapter 通过 CLI 探测并解析结构化输出。
- P2 已实现 controlled/native/coexistence 的计划字段、加载方法、Profile 内统计和 Claude native 插件路径；Codex native 在能力不支持时明确拒绝。
- P3 已实现 train/validation EvidenceView、Wiki 假设、父版本不变的候选快照、diff 和三态 validation gate。
- P4 已实现本地 Registry 发布、导出收据、乐观并发检查、回滚、插件清单和 MCP JSON-RPC 桥接。
- `tests/` 覆盖 35 个回归测试和 3 个 CLI 端到端测试。mock 与 fake CLI 只用于工程验证，不能作为平台或模型效果结论。

## 1. 建议顺序

```text
契约与评分器 → 单平台评测 → 跨平台对照 → Wiki 与候选迭代 → 插件交付
```

第一条可用链路：导入现有 Skill 和小型任务包，固定两个条件，在独立会话执行，评分并输出带原始证据的报告。

## 2. 阶段与完成条件

| 阶段 | 交付物 | 完成条件 |
| --- | --- | --- |
| P0：契约与固定样例 | JSON Schema、CLI 骨架、快照存储、mock Runner、一个可判定任务包 | 无模型调用也能走通 plan → execute(mock) → grade → report；错误产物确实失败 |
| P1：首个真实执行器 | Codex Adapter、临时 Worker、none/v1 对照 | 代码已实现；本地 fake CLI 验证独立会话、产物、超时/错误分类。真实 Worker 和认证仍待实测 |
| P2：跨平台对照 | Claude Code Adapter、Profile 内比较、三组矩阵 | 代码已实现并验证模式边界；两端完整一致性矩阵和真实原生触发仍待实测 |
| P3：演化闭环 | 训练 EvidenceView、Wiki、Proposal、validation/回归门禁 | 代码与回归测试已实现；真实分析模型接入和多轮预算策略留作后续增强 |
| P4：插件分发 | 两端管理 Skill/清单、CLI/MCP 桥接、版本导出 | 本地插件清单、MCP 工具和 Registry 已实现；宿主平台安装包发布仍需按平台打包验证 |

P0/P1 使用 smoke Suite 验证工程；进入正式效果声明前增加足够任务族并校准统计政策。P3 提供候选快照和门禁的演示链路；当前 `evolve` 使用 mock 与固定指导段落，真实不同 Skill 版本绑定、分析模型接入和候选再评测仍需按新架构落实。

## 3. P0 可直接拆分的工作

1. 定义 SkillSnapshot、SuiteSnapshot、RunPlan、Trial、Grade、Comparison 的 JSON Schema 与合法/非法样例。
2. 实现 Skill 全包快照与内容摘要；验证资源遗漏、路径冲突和源目录保护。
3. 实现 Suite 导入、任务族切分及隐藏材料投影；检查不同 split 的重叠。
4. 实现 plan 展开、三组条件、重复编号、预算上界和比较指纹。
5. 实现 mock Runner 的完成、任务失败、基础设施错误、超时与中断事件。
6. 实现外部代码评分器，使用已知错误/正确产物校验评分器本身。
7. 实现 SQLite 索引、事件与对象提交，以及断点恢复。
8. 输出 JSON、Markdown 和静态 HTML 报告，展示逐题差异和缺失值。

每项都有独立输入/输出，接口由 contracts 统一，避免各模块自己发明字段。

## 4. 关键验证清单

| 验证对象 | 必须能发现的问题 |
| --- | --- |
| 快照 | 修改引用脚本后摘要没变、丢失资源、越界符号链接 |
| 数据投影 | 隐藏答案或其他实验产物被复制进任务工作区 |
| 执行 | 平台返回码为 0 但任务没完成、超时后子进程仍运行 |
| 隔离 | 用户记忆/其他 Skill 被加载、同一工作区被复用 |
| 评分 | Agent 声称成功但产物错误、隐藏测试被篡改、评分器崩溃 |
| 比较 | 将重复尝试当独立题目、缺失成本填 0、混合不同配置 |
| 演化 | 用 test 失败改 Skill、Proposer 改评分规则、失败提案被当成成功知识 |
| 版本 | 过期父版本覆盖新发布、候选 diff 不匹配、回滚丢失历史 |

## 5. MVP 完成定义

用户导入一个普通 Skill 包，选择一个已验证 Suite 和两端 Profile，获得：

- 无目标 Skill、当前和候选版本的同条件对照。
- 逐题评分、失败证据、成本/时延或清楚的 unknown。
- 可追溯的 Wiki 条目和单次候选 diff。
- validation/回归门禁结论，以及冻结版本的最终审计路径。
- 版本发布与两端导出收据。

这一闭环真实跑通并通过错误场景验证后，才称为可用 MVP。公开排行榜、任意 Skill 自动出题、在线记忆、分布式云服务和持续后台自动发布是后续范围。

## 6. 首次真实运行前要落实的配置

以下是实施时需要填入的环境信息，不阻碍本轮架构设计：

- 用户指定的首个待测 Skill、数据许可和代表性任务。
- 两端可用的明确模型配置和非交互认证方式。
- 单次实验的时间/用量预算以及并发限制。
- 可运行两端 CLI 的隔离 Worker 镜像及依赖锁定。

未取得这些运行配置前，使用 mock/fake CLI 完成工程验收，不生成虚构的真实平台测评结果。
