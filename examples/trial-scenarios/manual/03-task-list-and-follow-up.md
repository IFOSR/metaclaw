# Manual Scenario 03: Task List, Detail, And Follow-Up

目标：验证任务清单命令、详情命令，以及已完成任务后的 follow-up 场景。

## 步骤

1. 新建一个真实技术调研任务：

```text
帮我做个调研，目前 hermes-agent 与 openclaw 的主要差异是什么
```

2. 完成后执行：

```text
/tasks
/tasks done
```

3. 从 `已完成` 里复制任务 ID，查看详情：

```text
/task <task_id>
```

4. 然后围绕同一主题再提一个后续问题：

```text
继续，结合开发者体验和生态成熟度，再给我一个选型建议
```

## 预期

- `/tasks` 应分组展示任务
- `/tasks done` 只展示已完成任务
- `/task <task_id>` 能看到目标、状态、摘要、资源
- 如果系统判定这是 follow-up，而不是直接重跑原任务，应创建新的跟进任务

## 建议观察点

- 任务标题是否容易区分
- 后续问题是被归并到旧任务，还是新建跟进任务
- `/tasks` 中两个相关任务的状态是否清晰
