# AI Coding Agent 并发会话干扰问题：应对策略汇总

> 调研时间：2026-06-25  
> 主要研究对象：Claude Code（Anthropic），兼及同类 Agent 的通用模式

---

## 一、核心问题

当两个（或多个）AI coding agent 窗口在同一工作区并行工作时，面临三类干扰：

| 干扰类型 | 表现 | 严重程度 |
|---------|------|---------|
| **文件编辑冲突** | 两个 session 同时修改同一文件，互相覆盖 | 🔴 致命 |
| **资源竞争** | API 配额/速率限制共享、MCP server 内存膨胀 | 🟡 显著 |
| **上下文/状态污染** | 一个 session 的状态（临时文件、锁、进程）影响另一个 | 🟡 中等 |

---

## 二、Claude Code 的解决方案（按隔离层级）

### 2.1 文件级隔离：Git Worktrees（主力方案）

Claude Code 的**核心隔离机制**是 `git worktree`——每个 session 拥有独立的文件系统检出一份。

```bash
# 在不同终端启动两个完全隔离的 session
claude --worktree feature-auth    # terminal 1
claude --worktree bugfix-123      # terminal 2
```

**工作原理：**
- `--worktree` / `-w` 标志在 `.claude/worktrees/<name>/` 下创建独立的 git worktree
- Worktree 有自己的分支和文件系统视图，共享同一个 `.git` 仓库历史
- 不同 session 的编辑互不触碰——一个 session 改 `src/auth.ts`，另一个改 `src/payment.ts`，各自在自己的 worktree 里
- 退出时根据是否有未提交变更，自动清理或提示保留

**子 agent 的 worktree 隔离：**
- Subagent 可通过 `isolation: worktree` 配置（在自定义 subagent 定义中）自动获得临时 worktree
- Subagent 完成且无变更后，临时 worktree 自动删除
- Agent 运行期间对 worktree 执行 `git worktree lock`，阻止并发清理
- v2.1.187 修复了：killed agent 产生的 stale lock 现在会自动清理

**非 git 场景：**
- 通过 `WorktreeCreate` / `WorktreeRemove` hooks 支持 SVN、Perforce、Mercurial 等
- Desktop App 为**每个新 session 自动创建 worktree**

**`.worktreeinclude` 文件：**
- 用 `.gitignore` 语法指定哪些 gitignored 文件（如 `.env`、`secrets.json`）需复制到新 worktree
- 只复制被 gitignore 的文件，不会重复 tracked 文件

### 2.2 任务级协调：Agent Teams（实验性）

当两个 session 需要**主动协作**而非完全隔离时，使用 Agent Teams：

```
Spawn three teammates: one for security review, one for performance,
one for test coverage. Have them each review PR #142 and report findings.
```

**架构：**
- **Team Lead**：主 session，负责分派任务、协调进度、合成结果
- **Teammates**：独立的 Claude Code 实例，各有自己的 context window
- **Shared Task List**：采用文件锁防竞态，teammate 自领取或 lead 分配
- **Mailbox**：teammate 之间可直接通信

**关键约束：**
- 一个 session 只有一个 team
- Teammate 不能再 spawn 子 teammate
- 要求 teammate 各自操作**不同的文件**（文档明确说："Break the work so each teammate owns a different set of files."）
- Session 恢复时不保留 in-process teammate
- 需设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

### 2.3 会话级管理：Session Picker & Branching

```
claude --resume            # 打开 session picker
claude --resume <name>     # 按名称恢复
claude --continue          # 恢复最近 session
/branch try-new-approach   # 从当前对话分叉新 session
```

- Sessions 按项目目录存储，session picker 可跨 worktree 搜索
- `/branch` 创建对话副本，原 session 不变——可并行探索不同方案
- Desktop App / Web / VS Code 各自维护独立的 session 历史

---

## 三、已知问题（来自 GitHub Issues）

### 3.1 API 速率限制共享

**Issue #70308** — 同一账户 6 个并发 session 时，API 延迟飙升至 60s+：
- 所有 session 共享同一个 API rate/concurrency budget
- 即使 CPU 和网络空闲，多 session 并发也会触发账户级限流
- 一个 session 的 429 错误会导致整个 session 硬失败（无退避）

**Issue #46037** — 用量仅 65% 却收到 429：
- Sonnet 模型配额用完后，Opus/Haiku 也受影响
- 似乎是 per-model 配额 + 账户级限流的复合问题

### 3.2 MCP Server 资源膨胀

**Issue #70564** — Cowork/remote runner 无条件加载所有已安装插件的 MCP server：
- 每个 session ~2.3 GB RSS（仅 MCP server）
- 2 个并发 session ≈ 5 GB；第 3 个触发 OOM kill
- `enabledPlugins` 设置对 remote runner 无效
- 提议方案：per-session MCP allowlist / 懒加载 MCP server

### 3.3 Windows 下工具 I/O 损坏

**Issue #69994** — 高并发 + 长 session 下：
- Write 工具报成功但文件未落盘
- Bash/Read 输出被回放/伪造
- 非 ASCII 输出出现乱码（mojibake）
- 3-7 个并发 CC 实例时更频繁
- 临时缓解：`UV_THREADPOOL_SIZE=16`、减少并发实例、定期重启长 session、关键写入走独立进程验证

### 3.4 其他

- **Issue #70523**: 并行 subagent + per-agent MCP fan-out 导致宿主机 OOM
- **Issue #70211**: 后台 worker/scheduled-task 进程不回收，累积耗光内存
- **Issue #70477**: remote/bridge session 静默禁用 auto-compaction

---

## 四、模式总结：Agent 并发隔离的通用策略

### 策略 A：文件系统隔离（最强）

| 方案 | 代表 | 适用场景 |
|------|------|---------|
| Git worktree | Claude Code `--worktree` | 需要完全独立的文件修改 |
| 容器/VM 隔离 | Claude Code Web（云端 VM） | 完全隔离，无本地资源竞争 |
| 独立 clone | 手动 `git clone` 两份 | 最原始但最可靠 |

### 策略 B：任务分区协调

| 方案 | 代表 | 适用场景 |
|------|------|---------|
| Agent Teams | Claude Code 实验性功能 | 一个任务拆成多个独立子任务 |
| Subagent 委托 | Claude Code / Copilot | 研究、review 等只读子任务 |
| Writer/Reviewer 模式 | Claude Code 推荐 | 一个写、一个审，天然不冲突 |

### 策略 C：运行时约束

| 方案 | 说明 |
|------|------|
| 不同文件分工 | 让不同 session 各自修改不同的文件集合 |
| 定期 `/clear` | 定期重置上下文，避免状态累积 |
| Session 命名 | 像 git branch 一样给 session 命名 |
| `/branch` 分叉 | 从当前对话分叉，探索不同方案 |

### 策略 D：防御性验证

| 方案 | 说明 |
|------|------|
| Out-of-band 验证 | 用独立进程检查关键写入是否真实落盘 |
| Nonce/hash 校验 | 写入后外部验证内容完整性 |
| 不合并 Write + Bash + Agent | Cluade Code issue #69994 的 workaround：一个 turn 只做一件事 |
| 定期重启长 session | 避免进程内状态累积导致的损坏 |

---

## 五、对 MetaClaw 项目的启示

MetaClaw 作为多 agent 调度平台，可以参考 Claude Code 的设计：

1. **Worktree 是第一道防线**：如果 MetaClaw 需要并行执行多个 agent task，为每个 task 分配独立 worktree 是最可靠的隔离方式
2. **任务分区优先于文件锁**：与其用文件锁做冲突检测，不如在任务规划阶段就确保不同 task 操作不同文件
3. **Agent Teams 的 task-list + file-lock 模式**可以借鉴用于 multi-agent 协调
4. **资源配额管理**是并发多 agent 的隐藏难点——API 限流、MCP server 内存、进程泄露都需要主动管理
5. **验证闭环**不可少：agent 声称"写入成功"不等于真的写入成功，需要 out-of-band 验证机制

---

## 参考来源

- [Claude Code Worktrees 文档](https://code.claude.com/docs/en/worktrees)
- [Claude Code Agent Teams 文档](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Session Management 文档](https://code.claude.com/docs/en/sessions)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- GitHub Issues: #69994, #70308, #70564, #70451, #46037, #70523
