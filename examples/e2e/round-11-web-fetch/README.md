# Round 11: Web Fetch

目标：让网页链接材料不只是 URL，而是能抓到可读摘录并注入执行上下文。

## 真实验收

1. 启动本地网页夹具：
   `python3 -m http.server 8123 --bind 127.0.0.1 --directory examples/e2e/round-11-web-fetch/fixtures`
2. 用真实 `codex-cli` 运行：
   `METACLAW_HOME=/tmp/metaclaw-e2e-round11 node dist/index.js --script examples/e2e/round-11-web-fetch/scripts/00-web-fetch-smoke.txt`
3. 预期结果：
   执行进度中出现 `已提取 1 份可读摘录`
4. 预期结果：
   材料摘录里能看到 `Phoenix Weekly` 和网页正文
5. 预期结果：
   最终输出明确引用网页中的事实，而不是只复述 URL
