# 设计依据与验证状态

核对日期：2026-09-15。本文件区分论文机制、官方接口事实和项目设计提案。

## 1. 论文依据

[WikiSkill v1 全文](https://arxiv.org/html/2608.27454v1)及[原始 PDF](https://arxiv.org/pdf/2608.27454v1)。

本设计保留三层知识结构、从轨迹维护 Wiki、生成单个 Skill 修改、验证后接受/回滚，以及保留失败尝试的历史。论文的实验使用直接注入的 Skill；本产品另外设计自然触发模式和平台适配检查。本文档没有复现论文实验，也不引用对话中示例分数作为产品结果。

## 2. 官方接口依据

| 来源 | 已确认的信息 | 本设计的用法 |
| --- | --- | --- |
| [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) | `codex exec` 和 JSONL 输出 | 首批 Runner 的进程和事件入口 |
| [Claude Code 非交互模式](https://code.claude.com/docs/en/headless) | print 模式和 JSON/stream-json 输出 | 另一个 Runner 的进程和事件入口 |
| [Claude Code 插件规范](https://code.claude.com/docs/en/plugins) | 插件可打包 Skill 等扩展 | 管理入口的平台包装，前文已核对 |
| [Agent Skills 格式](https://agentskills.io/specification) | SKILL.md 目录及附带资源 | 保留标准 Skill 内容，附加评测 sidecar |

这些接口证明接入方向可行，不证明不同平台配置可以完全等价，也不证明本地目录隔离具有完整访问控制。

## 3. 本机只读检查

运行了帮助与版本查询，没有启动被测 Agent、调用模型 API、安装插件或改动平台配置。

| 检查 | 结果 |
| --- | --- |
| `codex --version` | `codex-cli 0.154.0-alpha.6.2` |
| `codex exec --help` | 包含 `--json`、`--ephemeral`、`--model`、`--ignore-user-config` 等入口 |
| `claude --version` | `2.1.228 (Claude Code)` |
| `claude --help` | 包含 `--print`、`--output-format`、`--plugin-dir`、`--no-session-persistence` 等入口 |

Codex 帮助查询伴随无法创建 PATH aliases 的权限提示，但帮助和版本成功返回；本轮未通过提权修改环境。设计不将帮助查询成功视为运行兼容性测试通过。

## 4. 实施时必须验证的假设

- 本机平台版本与目标 Worker 版本的参数是否一致。
- 用户配置、记忆、背景 Skill 与项目指令能否被明确固定或隔离。
- 两端 Skill 加载是否能得到足够的可观测证据。
- 认证、模型选择、模型回退和事件完整度的实际行为。
- 任务进程停止、隐藏评分器保护、断点恢复和产物完整性。

## 5. 方法说明

评测设计采用 Eval Harness 的“先定义成功与回归条件，再执行并比较”方法，并结合本项目的跨平台需要增加可比性指纹、任务级配对和证据隔离。未使用该技能附带的执行工具或宣称其隔离后端已经可用。

架构中的 TypeScript、本地存储、模块布局、三态门禁和阶段计划是当前项目建议，不是论文或平台官方规定。
