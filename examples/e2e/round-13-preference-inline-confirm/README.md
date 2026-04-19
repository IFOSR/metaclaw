# Round 13: Preference Inline Confirm

目标：让候选偏好不再只靠 `/memory confirm`，而是可以直接用 `y / n / e <新内容>` 完成交互。

## 真实验收

1. 用真实 `codex-cli` 运行：
   `METACLAW_HOME=/tmp/metaclaw-e2e-round13 node dist/index.js --script examples/e2e/round-13-preference-inline-confirm/scripts/00-inline-confirm-smoke.txt`
2. 预期结果：
   第三次重复模式后，输出里出现 `[y] 确认`、`[n] 忽略`、`[e <新内容>] 编辑后确认`
3. 预期结果：
   输入 `y` 后，不再创建新任务，而是直接确认该偏好
4. 预期结果：
   `/memory` 输出中能看到刚确认的偏好
