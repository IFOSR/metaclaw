# Manual 01: Conversation Does Not Create Task

## Goal

验证普通对话和短继续不会进入任务系统。

## Steps

1. 启动 Metaclaw
2. 输入：`hi`
3. 输入：`未来随着基座模型的能力越来越强，是否还需要 harness`
4. 输入：`可以，继续`
5. 输入：`/tasks`

## Expected

- `hi` 不创建任务
- harness 讨论作为普通对话返回
- `可以，继续` 延续刚才讨论，不创建新任务，不恢复旧任务
- `/tasks` 中不出现 `hi`、`可以，继续`、harness 讨论本身

## Fail Examples

- 对话消息被记录为 `DONE` 任务
- `继续` 被错误关联到 parked 任务
- `/tasks` 里出现大量闲聊条目
