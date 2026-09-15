# SkillBenchmark：跨平台 Skill 评测与迭代

状态：架构草案 v0.1，2026-09-15。SkillLab 是工作名称，尚未确定最终产品名。

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

| 文档 | 解决的问题 |
| --- | --- |
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

当前已交付 P0 的本地 mock 链路：`plan → execute(mock) → grade → report`。它用于验证契约、产物和回归检查，不代表真实平台或模型的测评结果；Codex/Claude 执行器、插件安装包和真实测评仍未实现。

## 快速开始

需要 Node.js 22 或更高版本（Node 原生运行当前 TypeScript 源码）：

```bash
npm test
npm run demo
```

`npm run demo` 会运行 `suites/smoke/suite.json`，并将 `plan.json`、`report.json` 和 `report.md` 写入被 Git 忽略的 `.skillbenchmark/runs/demo/`。

也可以对自己的 Suite 生成计划或运行 mock 评测：

```bash
npm run skillbenchmark -- plan suites/smoke/suite.json .skillbenchmark/runs/plan
npm run skillbenchmark -- run suites/smoke/suite.json .skillbenchmark/runs/custom
npm run skillbenchmark -- snapshot path/to/skill
```

## 参与开发

先阅读[贡献指南](CONTRIBUTING.md)，再按[实施计划](docs/implementation-plan.md)推进。当前只使用 Node 内置模块，无需安装运行时依赖；`npm test` 是现有的自动化验证命令。

- [AGENT.md](AGENT.md)：共享的 Agent 协作规范。
- [AGENTS.md](AGENTS.md)：Codex 等工具的项目规则入口。
- [CLAUDE.md](CLAUDE.md)：Claude Code 的项目规则入口。
