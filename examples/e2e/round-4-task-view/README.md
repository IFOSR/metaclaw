# Round 4: Task View And Result Aggregation

目标：让 Metaclaw 的任务详情真正成为“任务视图”，而不是执行器日志的旁路展示。

本轮验收重点：

- `/task <id>` 能回答“这是什么任务、做到哪了、为什么停下、接下来做什么”
- 完成后的结果被聚合成任务级摘要，而不是只剩 transcript
- 关联材料、阻塞原因、恢复入口在任务视图里稳定可见
- 用户无需翻日志就能理解任务当前工作区状态

## 场景清单

### 脚本化场景

- `scripts/00-task-view-smoke.txt`
  - 验证创建任务、完成任务、查看任务详情的最小闭环
  - 脚本支持 `{{last_task_id}}` / `{{current_task_id}}` 占位符，便于串联 `/task <id>` 验收步骤

### 手动场景

- `manual/01-task-detail-shows-workspace-state.md`
  - 验证任务详情视图完整展示状态、摘要、下一步、材料

- `manual/02-result-aggregation-and-next-step.md`
  - 验证任务完成后结果聚合与下一步建议

- `manual/03-material-and-block-recovery-view.md`
  - 验证 blocked / resumed 任务在任务视图里的材料和恢复信息

## 本轮通过标准

- 三个手动场景全部通过
- 脚本化场景可稳定运行
- `/task <id>` 不再像元数据 dump
- 用户不需要翻 executor transcript 才能理解任务状态
