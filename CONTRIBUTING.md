# 贡献指南

## 当前阶段

本仓库处于 v0.1 首版实现阶段。先通过 README.md 阅读设计文档，再按 docs/implementation-plan.md 的验收条件推进。当前 TypeScript 使用 Node 原生类型剥离运行；本地 SQLite、对象存储、真实 CLI Adapter、统计门禁、演化和发布入口已具备，生产级隔离 Worker 与真实平台一致性验证仍需运行配置。

## 目录与文档

- README.md：项目概览、交付状态与文档导航。
- docs/：架构、协议、接口、平台适配、示例和实施计划。
- AGENT.md：共享的 Agent 协作规范；AGENTS.md 和 CLAUDE.md 为工具入口。
- .editorconfig、.gitattributes、.gitignore：编辑格式、换行与版本控制边界。

新增文档应从 README.md 或已有相关文档链接可达。使用相对链接，示例须注明假设和未实现能力。调整协议时同步更新契约、示例与验收条件。

## 工作与提交

1. 从 main 创建用途清楚的短期分支，例如 `docs/evaluation-clarity` 或 `feat/run-plan`。
2. 每次修改围绕一个明确问题，检查 diff，保留不属于本次工作的已有修改。
3. 文档变更核对本地链接、代码块闭合与术语一致性，并执行 `git diff --check`。
4. 引入代码时补充真实运行命令与必要测试，并在提交前执行与变更相关的检查。
5. 提交信息使用 `类型: 简短说明`，例如 `docs: clarify evaluation protocol`；常用类型为 feat、fix、docs、refactor、test、chore。

PR 说明应交代问题、修改后的行为与验证结果。没有执行的检查明确标注，不能用设计样例代替运行证据。

## 数据与本地配置

不要提交密钥、账号令牌、个人绝对路径或私有实验轨迹。配置模板只能使用占位值。演示任务与固定样例需要明确来源和可使用范围；运行产物放在独立数据目录或被忽略的本地目录。

当前无需安装运行时依赖。使用 `npm test` 运行回归和端到端测试，使用 `npm run demo` 验证本地 mock 链路；`run-adapter`、`evolve` 和 `release` 命令需要相应的本地目录或平台 CLI。
