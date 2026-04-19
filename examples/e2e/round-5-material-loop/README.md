# Round 5: Material Loop

目标：让 `补材料 -> 看见材料 -> 继续任务` 成为一条稳定可验收的 CLI 闭环。

本轮验收重点：

- `/attach` 支持一次关联多个文件
- `/attach <taskId> <file...>` 支持在没有当前任务时给指定任务补材料
- 给 blocked 任务补材料后，系统明确提示后续恢复动作
- `/task <id>` 中能稳定看到更新后的材料列表

## 场景清单

### 脚本化场景

- `scripts/00-attach-multiple-materials.txt`
  - 验证创建任务、给指定任务补多个材料、查看任务详情的最小闭环

### 手动场景

- `manual/01-attach-to-current-task.md`
  - 验证当前任务一次附加多个材料

- `manual/02-attach-to-blocked-task-by-id.md`
  - 验证 blocked 任务在没有当前任务时仍可通过显式 task id 补材料

## 本轮通过标准

- `/attach` 不再把多个文件错误拼成一个路径
- 显式 task id attach 可以在无当前任务时工作
- blocked 任务补材料后有明确恢复提示
- 任务详情里的材料列表与实际 attach 操作一致

