# 示例：评测并改进一个代码修复 Skill

本文全部任务、名称和分数仍为设计示例，不代表已经执行实验。工作流用于说明协议；当前可执行命令和参数以 [README](../../README.md) 为准。

## 1. 用户要完成的操作

用户已有 `repair-python` Skill，想知道它对修复成功率是否有帮助，以及修改之后能否在 Codex 和 Claude Code 上稳定改善。

操作入口可在任意一个平台；被测任务由两个独立 Runner 执行。一次评测的结果不依赖入口使用哪个模型解释报告。

## 2. 准备一个最小任务包

先做 20 道明确可判定的小型 Python 修复任务：8 道 train、8 道 validation、4 道 test，按来源分组切分。这只是验证工程链路的 smoke Suite，样本量不足以认证小幅能力提升。

示例题目：`parse_tags` 接收空字符串时应返回空列表；当前返回单个空元素。要求兼容前后空白、多个分隔符，并保持有效标签顺序。

```text
公开输入
  issue.md                问题与接口契约
  repository/             固定的错误实现、已有公开测试和依赖锁文件

评分器专用存储
  hidden-tests/           空输入、空白、合法输入和顺序断言
  reference-fixture/      原始实现快照
  grading-policy.json     固定评分政策
```

主要通过条件是隐藏行为测试通过、既有行为无回归。是否增加回归测试作为独立指标：将新增测试放回原始错误实现，检查它是否能暴露原问题；随后检查候选实现是否通过。不能只数文件或相信 Agent 的最终总结。

用户只有 Skill、没有题目时，产品支持生成 Suite 草稿。每题必须校验输入、期望和评分器，并提供已知错误/正确产物来测试评分器。候选版本开始运行后，不再调整题目难度或评分标准。

## 3. 导入、计划和执行

```text
skilllab skill import ./repair-python --label v1
skilllab suite import ./python-repair-smoke
skilllab profile inspect codex-local
skilllab profile inspect claude-local
skilllab experiment plan ./experiment.yaml
skilllab experiment run ./experiment.yaml
skilllab report <run-id>
```

配置的设计示例：

```yaml
schema_version: "0.1"
suite: python-repair-smoke@frozen
split: validation
mode: controlled
load_method: explicit-file-read
profiles:
  - codex-local
  - claude-local
conditions:
  - id: none
    skill: null
  - id: incumbent
    skill: repair-python@v1
repeats: 3
budget:
  max_trials: 96
  max_attempts: 192
  per_trial_timeout_seconds: 300
  max_infrastructure_retries: 1
  max_concurrency: 2
statistics:
  unit: task
  confidence_level: 0.95
policy: smoke-diagnostic-only
```

Profile 文件提供实际平台、模型与 Worker；`plan` 把所有标签解析为内容摘要和实际版本，冻结后再运行。缺模型配置或环境未通过隔离检查时，计划中给出原因。

此次计划为 2 个 Profile × 2 个条件 × 8 道题 × 3 次重复 = 96 个计划项；每项最多一次基础设施重试，因此实际启动次数上限为 192。300 秒是单次上限，既不是耗时预测，也不是费用估计。增加候选第三组的完整矩阵为 144 个计划项，必须相应调整并重新冻结预算。

## 4. 从训练证据形成候选

另运行 train split，Wiki 发现一种可能的问题：Agent 在尚未确认空输入语义时直接改字符串处理逻辑，既有测试又没有覆盖空输入。

记录必须拆成：

- 观察：哪些轨迹的哪些工具输出、测试结果支持这个现象。
- 假设：在实现修改前明确边界条件并建立失败测试，可能降低盲目修改。
- 反例：有的任务没有先写测试也能成功，不能断言所有失败都是同一原因。
- 修改：在现有 Skill 中增加一段边界条件与复现要求。
- 预测：隐藏行为测试成功率提升，Token 增幅不超过预定上限。

候选 diff 示例：

```diff
 在修改前理解问题及相关实现。
+对照问题描述列出输入边界和预期输出。
+尝试用最小测试或命令复现问题；保存失败证据。
+修复后确认同一检查通过，并验证相关既有行为。
+无法复现时明确说明缺失条件，不把假设描述为已验证原因。
```

候选正文来自训练证据，不能加入 validation 题号、测试答案或要求 Agent 修改评分器的内容。

## 5. 验证候选

```text
skilllab evolve <training-run-id> --max-rounds 1
skilllab proposal show <proposal-id>
skilllab experiment plan ./candidate-experiment.yaml
skilllab experiment run ./candidate-experiment.yaml
```

新计划在相同任务与配置下比较三组。旧结果是否可复用由指纹和预设新鲜度政策决定；首版默认同批重跑，避免只拿过期基线作比较。

报告示意，仅展示某一个 Profile：

| 条件 | 成功次数 / 有效尝试 | 成功率 |
| --- | --- | --- |
| none | 14 / 24 | 58.3% |
| incumbent | 16 / 24 | 66.7% |
| candidate | 20 / 24 | 83.3% |

这些汇总数只能说明点估计变化，不能计算可靠的配对区间。真实报告还必须有逐题逐次结果、基础设施失败、关键回归和用量。这个 8 道验证题的 smoke 实验返回诊断结果，不自动发布。

扩大任务覆盖并冻结正式政策后，才按照[评测协议](../evaluation-protocol.md)作 accept/reject/inconclusive 决策。最终测试审计前冻结候选；test 结果保留给实验拥有者，不交给 Wiki 或 Proposer。

## 6. 保存成果

```text
skilllab release publish <accepted-proposal-id>
skilllab release export <release-id> --platform codex --output ./exports/codex
skilllab release export <release-id> --platform claude-code --output ./exports/claude
```

发布收据带 Skill 摘要、父版本、评测报告和适用 Profile。导出产生独立包，用户可以之后安装用于日常任务。平台专属字段存在不兼容时报告诊断，而不是静默转换后声称同一个 Skill 在两端都通过。

## 7. 扩展到其他 Skill

| Skill 类别 | 任务环境 | 主要评分依据 |
| --- | --- | --- |
| 结构化文档抽取 | 固定文档、离线读取工具 | 字段精确性、遗漏率、证据定位 |
| 表格处理 | 固定工作簿与输出目录 | 单元格值、公式/格式约束、非目标范围变化 |
| 报告写作 | 固定材料、输出文档 | 引用核对、结构检查、盲评 rubric |

核心调度、对照、Wiki 和版本管理保持一致，只更换 Suite、环境和评分器。首个代码修复 Suite 是实现载体，不限制产品评测其他 Skill。
