# Round 12: Risk Gate

目标：把高风险外发动作拦在执行前，必须经用户显式确认后才继续。

## 真实验收

1. 用真实 `codex-cli` 运行：
   `METACLAW_HOME=/tmp/metaclaw-e2e-round12 node dist/index.js --script examples/e2e/round-12-risk-gate/scripts/00-risk-gate-smoke.txt`
2. 预期结果：
   第一条高风险输入后，不会立刻派发给执行器
3. 预期结果：
   输出里出现 `⚠️ 这是高风险动作` 和 `确认执行`
4. 预期结果：
   在输入 `确认执行` 后，才创建任务并继续执行原请求
