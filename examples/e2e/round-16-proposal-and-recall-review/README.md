# Round 16: Proposal And Recall Review

目标：验证 V2 的半自动推进链路已经完整打通。

## 本轮验收要点

1. 系统会把主动建议展示为 `操作提案`
2. 用户接受 proposal 后，不会立刻执行，而是先进入 `记忆召回确认`
3. recall review 展示的是可判断摘要，不是原始数据库记录
4. 用户可以选择：
   - `y` 全部采用
   - `n` 全部忽略
   - `s 1 2` 部分采用
   - `a` 后续同类自动采用
5. 只有确认通过的记忆会进入执行上下文
6. `/memory review-policy` 可以查看已授权的自动采用策略

## Smoke 脚本说明

`scripts/00-proposal-and-review-smoke.txt` 用于 scripted smoke。

这个 smoke 依赖一个现实前提：

- 当前 session 中已经至少存在一个会在启动时或完成后触发 proposal 的任务

脚本本身主要验证：

- proposal 接受
- recall review 接受
- review-policy 可见
