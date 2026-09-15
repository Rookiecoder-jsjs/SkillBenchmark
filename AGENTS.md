# Codex 项目入口

开始修改前阅读并遵循 [AGENT.md](AGENT.md) 中的共享规范，以及 [CONTRIBUTING.md](CONTRIBUTING.md) 中的开发约定。
共享规则统一维护在 AGENT.md；本文件仅保留工具入口和 CodeGraph 使用要求。

<!-- CODEGRAPH_START -->
## CodeGraph

仅当仓库根目录存在 `.codegraph/` 时，在搜索或读取代码以理解、定位实现前优先使用 CodeGraph：

- MCP 工具可用时使用 `codegraph_explore`，在问题中注明文件或符号；若工具延迟加载，先按名称发现工具。
- 否则使用 `codegraph explore "<符号或问题>"`。
- 没有 `.codegraph/` 时跳过 CodeGraph；是否建立索引由用户决定。
<!-- CODEGRAPH_END -->
