# Manual 03: Conversation Focus Beats Old Parked Task

## Goal

验证当系统里已经存在 parked task 时，当前对话焦点仍然优先，避免误恢复旧任务。

## Steps

1. 先创建一个 durable task，并让它进入 `PARKED`
2. 开始一段新的普通讨论，例如：`未来随着基座模型的能力越来越强，是否还需要 harness`
3. 输入：`可以，继续`
4. 输入：`把刚才那段分析存档到当前项目的 projects 目录下`
5. 输入：`/tasks`

## Expected

- 第 3 步延续当前对话，不恢复旧 parked task
- 第 4 步如果被识别为需要执行的工作，应创建一个新 follow-up task
- parked task 仍保持 `PARKED`
- 系统要能解释这是“按当前对话创建跟进任务”或等价表达

## Fail Examples

- 第 3 步或第 4 步直接关联到旧 parked task
- parked task 状态被错误改成 `READY` / `RUNNING`
- 用户无法判断系统为什么这么路由
