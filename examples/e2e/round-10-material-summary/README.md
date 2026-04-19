# Round 10: Material Summary

目标：在任务视图中补上材料概览和材料状态，回答“当前材料够不够”。

## 真实验收

1. 启动本地网页夹具：
   `python3 -m http.server 8123 --bind 127.0.0.1 --directory examples/e2e/round-11-web-fetch/fixtures`
2. 用真实 `codex-cli` 运行：
   `METACLAW_HOME=/tmp/metaclaw-e2e-round10 node dist/index.js --script examples/e2e/round-10-material-summary/scripts/00-material-summary-smoke.txt`
3. 预期结果：
   `codex-cli` 执行前的进度区展示 `材料概览`、`材料状态`、`本地文件材料`、`网页链接材料`
4. 预期结果：
   `/task {{last_task_id}}` 详情页中的 `材料概览` 与 `材料状态` 和执行阶段保持一致
