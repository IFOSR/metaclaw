# Manual 01: Task Detail Shows Workspace State

## Goal

验证 `/task <id>` 能像任务视图一样展示当前工作区状态。

## Steps

1. 创建一个 durable task
2. 等任务执行完成或进入 parked / blocked
3. 运行 `/tasks` 获取任务 id
4. 运行 `/task <id>`

## Expected

- 能看到任务标题与目标
- 能看到当前状态
- 能看到最新结果摘要
- 能看到下一步建议
- 能看到最近执行器和最近调度原因
- 有材料时能看到材料列表

## Fail Examples

- 只是一堆无结构字段
- 看不到结果摘要或下一步
- 看不到阻塞原因 / 材料入口
