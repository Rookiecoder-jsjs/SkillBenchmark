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

下一阶段产品形态为“本地启动即打开网页的 Skill 评测工作台”，详见[本地可视化工作台架构](docs/local-workbench-architecture.md)。W1 的第一条竖切片已经可运行：本地网页、启动工作区和 Codex/Claude Code 探测已接通；Skill 导入、可视化运行和历史对比仍按该架构继续实现。

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

`npm run dev` 以启动命令所在目录作为 Workspace，在 `127.0.0.1:4317` 启动本地服务并打开工作台。也可使用 `npm run skillbenchmark -- ui --workspace <dir> --port <port> --no-open` 明确指定目录、端口或禁止自动打开浏览器。当前页面提供工作区和本机 Agent 探测；尚未接通的入口会在界面中标注。

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
