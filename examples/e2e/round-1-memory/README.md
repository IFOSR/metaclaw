# Round 1: Memory Commercial Closure

目标：在不推翻现有任务调度与恢复主干的前提下，把 Memory 能力补齐到 PRD 可商用的最小完整版本。

本轮验收重点：

- 三次确认原则真正可用
- `Global / Project / Contact / Task-local` 可管理、可召回
- 记忆优先级裁决符合 PRD
- 恢复任务时优先延续 task-local 记忆
- TUI 明确展示注入的偏好、来源层级、置信度、命中原因

## 场景清单

### 脚本化场景

- `scripts/00-memory-command-smoke.txt`
  - 验证 scoped memory 命令的最小可用性
  - 验证 `/memory` 基础管理路径

### 手动场景

- `manual/01-three-hit-confirm-and-recall.md`
  - 验证三次确认和第四次召回

- `manual/02-scope-and-precedence.md`
  - 验证 Global / Project / Contact / Task-local 同时存在时的裁决

- `manual/03-task-local-resume-memory.md`
  - 验证任务恢复时优先延续 task-local 记忆

## 本轮通过标准

- 三个手动场景全部通过
- 脚本化场景可稳定运行
- TUI 中 memory 注入信息是结构化、稳定、可解释的
- 本轮相关测试全部通过
