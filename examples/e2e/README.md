# Metaclaw E2E Acceptance Packs

这套目录用于商用发布前的分轮验收，不替代单元测试或集成测试。

每一轮都遵循同一个规则：

1. 先写验收案例
2. 再实现代码
3. 再跑自动化测试
4. 最后按真实用户粒度手工验收

## 当前轮次

- `round-1-memory/`
  - Memory 商用闭环验收包
  - 覆盖三次确认、scope、precedence、恢复任务时的 task-local 记忆、TUI 注入透明度
- `round-2-guidance/`
  - Guidance 与提醒节流验收包
- `round-3-task-boundary/`
  - 普通对话 vs durable task 边界验收包
- `round-4-task-view/`
  - 任务视图、结果摘要、恢复提示验收包
- `round-5-material-loop/`
  - `/attach` 与阻塞补材料验收包
- `round-6-material-content/`
  - 文本材料注入执行上下文验收包
- `round-7-inline-materials/`
  - 自然语言 inline 文件材料验收包
- `round-8-web-links/`
  - 自然语言 inline 网页链接验收包
- `round-9-material-view/`
  - 文件/链接拆分展示验收包
- `round-10-material-summary/`
  - 材料概览、材料状态验收包
- `round-11-web-fetch/`
  - 网页内容抓取与摘录注入验收包
- `round-12-risk-gate/`
  - 高风险动作确认门控验收包
- `round-13-preference-inline-confirm/`
  - 候选偏好 `y/n/e` 交互验收包
- `round-14-task-artifacts/`
  - 任务产物回流与展示验收包

## 目录约定

- `scripts/`
  - 可脚本化运行的 smoke / scripted acceptance
- `manual/`
  - 需要在真实 TUI 中手动输入和观察的场景

## 使用原则

- 这些案例是“发布验收标准”，不是示例文档
- 如果某一轮案例还没跑通，该轮功能不算完成
- 如果 TUI 展示与预期不一致，即使逻辑正确，也不能算通过
- Round 10 之后的验收优先用真实 `codex-cli` 运行，而不是 fake executor
