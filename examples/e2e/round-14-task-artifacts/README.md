# Round 14: Task Artifacts

目标：让执行器写出的结果文件真正回流到任务对象里，而不是只出现在执行器输出中。

## 真实验收

1. 用真实 `codex-cli` 运行：
   `METACLAW_HOME=/tmp/metaclaw-e2e-round14 node dist/index.js --script examples/e2e/round-14-task-artifacts/scripts/00-task-artifacts-smoke.txt`
2. 预期结果：
   执行完成后出现 `已记录 1 个任务产物`
3. 预期结果：
   `/task {{last_task_id}}` 详情页中出现 `任务产物`
4. 预期结果：
   任务产物路径位于当前运行目录下的 `metaclaw-tasks/<task_id>/`
