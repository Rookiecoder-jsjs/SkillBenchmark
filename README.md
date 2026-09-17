# SkillBenchmark：跨平台 Skill 评测与迭代

状态：v0.1 首版工程实现，2026-09-15。SkillLab 是工作名称，尚未确定最终产品名。

仓库名称为 `SkillBenchmark`；设计文档中的 `SkillLab` 和 `skilllab` 分别表示产品工作名与拟定 CLI 名称。

项目帮助 Skill 作者回答三个问题：这个 Skill 是否有效、在哪些任务上失效、修改后是否真正变好。Codex、Claude Code 等平台既可以是操作入口，也可以是被测执行环境。

## 核心闭环

```text
导入 Skill 与任务集 → 固定实验配置 → 对照运行 → 独立评分
                                                ↓
发布版本 ← 验证与回归检查 ← 候选修改 ← Wiki 整理训练证据
```

一次实验固定 Skill 内容、任务快照、执行平台、模型、工具和预算；分别运行无目标 Skill、当前版本和候选版本。迭代器读取训练轨迹，产生可追溯的修改，并用新的执行结果验证。

## 设计文档

下一阶段产品形态为“本地启动即打开网页的 Skill 评测工作台”，详见[本地可视化工作台架构](docs/local-workbench-architecture.md)。W1 已接通本地网页、工作区、Agent 探测和不可变 Skill/Suite/计划；W2 已能从冻结计划启动 Codex/Claude Code Adapter，展示增量事件与 Trial 进度，保存、取消并重新打开运行。结果详情展示条件汇总、逐题评分/产物、墙钟与累计 Trial 耗时，以及可展开的平台事件时间线。W3 已支持历史运行对比、同一 Skill 的真实 v1/v2 版本对照，以及证据驱动的发布、受控导出和无损回滚。W4 首条竖切片已统一两端平台收据，并提供显式、可持久化的连接验证：安装、登录可用性和评测支持程度分别展示，单次连通成功不会被标记成“评测已验证”。真实账号下的完整一致性矩阵仍按该架构继续执行。

| 文档 | 解决的问题 |
| --- | --- |
| [本地可视化工作台架构](docs/local-workbench-architecture.md) | 网页流程、本机 Agent 探测、实时执行、历史对比、版本管理及落地步骤 |
| [项目架构](docs/architecture.md) | 产品边界、模块职责、部署和目录结构 |
| [评测协议](docs/evaluation-protocol.md) | 对照组、评分、数据隔离、统计与版本门禁 |
| [数据与接口契约](docs/contracts.md) | Skill、Suite、Run、Trial、事件与版本状态 |
| [平台适配](docs/platform-adapters.md) | 插件入口、Codex/Claude 执行器、能力探测 |
| [代码修复示例](docs/examples/code-repair.md) | 从待测 Skill 到候选版本的完整操作流程 |
| [实施计划](docs/implementation-plan.md) | 分阶段交付、验收条件与技术选择 |
| [依据与待验证事项](docs/sources.md) | 论文、官方文档和本机只读检查记录 |

## v0.1 的设计取舍

- 先提供本地 CLI、结构化结果和静态报告；平台插件调用同一个核心。
- 核心不绑定代码修复；任务环境和评分器通过 Suite 扩展。
- 首批目标执行器是 Codex CLI 与 Claude Code CLI，具体能力以探测和实测为准。
- 先测明确加载 Skill 后的效果，再扩展自然触发与多 Skill 共存评测。
- Wiki 保存可追溯的观察、假设和实验结果；评分与发布由确定性程序决定。
- 自动迭代产生候选版本；显式发布到本地注册表，导出到日常使用平台是另一个动作。

当前已交付 P0-P4 的本地首版链路：`plan → execute → grade → compare/gate → report`，并提供 Codex/Claude CLI Adapter、训练证据/Wiki/候选、发布注册表、平台导出、回滚和 MCP 桥接。mock 与 fake CLI 只用于工程验证，不代表真实平台或模型的测评结果；真实平台运行的能力状态默认为 exploratory，需在固定 Worker、认证和模型配置下单独完成一致性验证后才能作为正式成绩依据。

## 快速开始

需要 Node.js 22 或更高版本（Node 原生运行当前 TypeScript 源码）：

```bash
npm install
npm run dev
npm test
npm run demo
```

`npm run dev` 以启动命令所在目录作为 Workspace，在 `127.0.0.1:4317` 启动本地服务并打开工作台。也可使用 `npm run skillbenchmark -- ui --workspace <dir> --port <port> --no-open` 明确指定目录、端口或禁止自动打开浏览器。当前页面提供工作区、本机 Agent 探测、手动连接验证、Skill 与 Suite 导入/版本冻结、Agent 测试模型选择、单版本试跑、有效性对照和 v1/v2 版本对照，以及显式启动、进度/事件查看、取消、运行结果详情和两次已完成运行的历史对比；只有点击“验证连接”或“启动运行”才会调用所选 Agent。连接验证使用极小真实请求并可能产生少量费用，成功只表示当前登录和结构化输出可用，不代表完整评测能力已经验证。版本对照要求基准版和候选版属于同一个 Skill，按 `none / incumbent / candidate` 三组条件执行，各版本从独立冻结目录物化；结果中的门禁可为 accept、reject 或证据不足时的 inconclusive。完整且 accept 的候选会出现在 Skill 详情的“可发布证据”中；发布使用当前摘要乐观锁，Codex/Claude Code 导出只写入 Workspace 内的 `.skillbenchmark/exports/`，回滚仅追加指针事件，不删除版本或历史证据，也不会自动覆盖用户日常 Agent 目录。详情地址保存 Run ID，对比地址保存两个 Run ID，刷新后均可从本地报告恢复。历史对比会先检查 Suite、Agent/模型、Runner 配置、条件、重复次数、预算与加载方式；只有这些对齐后才可用于 Skill 归因或重复性判断。模型可设为 `default` 跟随本机 CLI，也可填写该 Agent 支持的模型 ID，并会进入计划指纹与历史证据。导入只读取源目录，内容对象、版本元数据和运行证据保存在当前 Workspace 的 `.skillbenchmark/` 中。

`npm run demo` 会运行 `suites/smoke/suite.json`，并将 `plan.json`、`report.json`、`report.md`、`report.html` 和 SQLite 索引写入被 Git 忽略的 `.skillbenchmark/runs/demo/`。

也可以对自己的 Suite 生成计划或运行 mock 评测：

```bash
npm run skillbenchmark -- plan suites/smoke/suite.json .skillbenchmark/runs/plan
npm run skillbenchmark -- run suites/smoke/suite.json .skillbenchmark/runs/custom
npm run skillbenchmark -- snapshot path/to/skill
npm run skillbenchmark -- skill import path/to/skill
npm run skillbenchmark -- suite import suites/smoke/suite.json
```

真实 CLI Adapter、演化和发布入口：

```bash
npm run skillbenchmark -- profile inspect codex
npm run skillbenchmark -- run-adapter codex suites/smoke/suite.json path/to/skill .skillbenchmark/runs/codex
npm run skillbenchmark -- evolve suites/smoke/suite.json path/to/skill .skillbenchmark/evolution/latest
npm run skillbenchmark -- release publish path/to/skill gate.json .skillbenchmark/registry
npm run skillbenchmark -- release export .skillbenchmark/registry <release-id> claude-code ./exported-skill
npm run skillbenchmark -- release rollback .skillbenchmark/registry <release-id>
```

`run-adapter` 会先探测本机 CLI；可用 `SKILLBENCHMARK_CODEX_COMMAND` 或 `SKILLBENCHMARK_CLAUDE_COMMAND` 指向测试替身。Codex 当前支持 controlled/coexistence，Claude Code 另支持 native；未通过真实一致性检查的能力会保持 exploratory。

## 参与开发

先阅读[贡献指南](CONTRIBUTING.md)，再按[实施计划](docs/implementation-plan.md)推进。Web 工作台使用 React 与 Vite，依赖由 `package-lock.json` 锁定；`npm test`、`npm run typecheck` 和 `npm run build:web` 是现有的自动化验证命令。

- [AGENT.md](AGENT.md)：共享的 Agent 协作规范。
- [AGENTS.md](AGENTS.md)：Codex 等工具的项目规则入口。
- [CLAUDE.md](CLAUDE.md)：Claude Code 的项目规则入口。
