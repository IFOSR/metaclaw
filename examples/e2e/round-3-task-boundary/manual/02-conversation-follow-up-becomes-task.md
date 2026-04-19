# Manual 02: Conversation Follow-Up Becomes Task

## Goal

验证基于刚才对话内容的后续动作会创建一个新的 durable task，并且执行器拿到刚才的对话上下文。

## Steps

1. 启动 Metaclaw
2. 输入：`未来随着基座模型的能力越来越强，是否还需要 harness`
3. 等待得到一段完整分析
4. 输入：`把刚才那段分析整理成三点结论`
5. 输入：`/tasks`
6. 输入：`/task <新任务id>`

## Expected

- 第 4 步创建一个新任务，而不是继续普通对话直接输出
- 新任务不是恢复旧 parked task
- 新任务执行结果明显承接刚才的 harness 分析，而不是从零开始胡乱生成
- `/tasks` 中能看到这个 follow-up 任务
- `/task <id>` 可看到这是一个正常任务对象

## Fail Examples

- 系统说“关联到任务 #旧任务id”
- 系统只回复“我无法直接写入/无法处理”，却没有实际创建任务
- 新任务输出与刚才讨论完全断裂
