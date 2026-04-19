# Round 3: Task Boundary And Context Alignment

目标：让 Metaclaw 在真实多轮使用里，既不会把普通对话错误塞进任务系统，也不会把基于当前对话的后续动作误绑到旧任务。

本轮验收重点：

- 普通对话不进入任务清单
- `继续` / `展开` 这类短跟进优先延续当前对话
- `把刚才那段分析整理/保存/存档...` 这类后续动作会创建新任务
- 已存在的 parked 任务不会错误抢走当前对话的 follow-up
- 新 follow-up 任务能继承刚才对话的上下文

## 场景清单

### 脚本化场景

- `scripts/00-conversation-follow-up-smoke.txt`
  - 验证对话 → 对话跟进 → 基于对话创建任务 → 查看任务清单

### 手动场景

- `manual/01-conversation-does-not-create-task.md`
  - 验证普通对话和短继续不会污染任务列表

- `manual/02-conversation-follow-up-becomes-task.md`
  - 验证基于刚才内容的后续动作会创建新任务并继承上下文

- `manual/03-conversation-focus-beats-old-parked-task.md`
  - 验证旧 parked 任务存在时，对话焦点仍优先

## 本轮通过标准

- 三个手动场景全部通过
- 脚本化场景可稳定运行
- `/tasks` 中不出现普通问候、短确认、身份设定等伪任务
- 对话衍生的后续动作能被系统解释清楚
