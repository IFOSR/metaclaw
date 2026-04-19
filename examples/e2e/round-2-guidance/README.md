# Round 2: Guidance Commercial Closure

目标：在不推翻当前调度和恢复主干的前提下，把 Guidance 能力补齐到 PRD 可商用的最小完整版本。

本轮验收重点：

- 启动时盘面能明确告诉用户当前该做什么
- 任务完成后会主动建议下一个动作
- blocked 解除后会主动给出恢复建议
- idle 状态下存在会话内提醒
- reminder 开关和 throttle 真正生效
- Guidance 文案始终说明“为什么”

## 场景清单

### 脚本化场景

- `scripts/00-dashboard-and-suggestion-smoke.txt`
  - 验证 startup dashboard 和 completion suggestion 的最小闭环

### 手动场景

- `manual/01-startup-and-completion-guidance.md`
  - 验证启动时盘面和任务完成后的建议

- `manual/02-idle-reminder-and-throttle.md`
  - 验证 idle 提醒与 throttle

- `manual/03-unblock-and-resume-guidance.md`
  - 验证 blocked 解除后的主动恢复建议

## 本轮通过标准

- 三个手动场景全部通过
- 脚本化场景可稳定运行
- 提醒不轰炸，且说明清楚“为什么现在提醒”
- 本轮相关测试全部通过
