# Metaclaw

> 任务连续性、偏好记忆与主动编排中枢

Metaclaw 是一个面向知识工作者的 TUI 应用，专注解决三个核心问题：

1. **Continuity（连续性）** — 任务被打断后能无缝恢复，跨天、跨会话保持上下文
2. **Memory（记忆）** — 自动沉淀用户偏好，减少重复说明
3. **Guidance（引导）** — 主动告诉你现在该做什么、哪里卡住了

## 快速开始

### 安装

```bash
npm install
npm run build
npm link
```

### 运行

```bash
metaclaw
```

首次启动会在 `~/.metaclaw/` 创建配置和数据库。

### 脚本化烟测

```bash
cat > /tmp/metaclaw-flow.txt <<'EOF'
帮我整理三份合同的风险点对比表
/tasks done
EOF

metaclaw --script /tmp/metaclaw-flow.txt
```

`--script` 会按行执行输入脚本，适合做可重复的端到端烟测。空行和以 `#` 开头的注释会被忽略。

## 核心功能

### 任务管理与执行

```bash
# 创建任务并自动执行（自然语言）
> 帮我整理三份合同的风险点对比表
任务 #task_abc123 已创建：帮我整理三份合同的风险点对比表
→ 派发给 codex-cli...
→ 正在执行任务 #task_abc123...
✓ 任务完成 (12.3s)

[执行器输出结果...]

💡 建议：继续处理任务 #task_xyz456: 审核财务报表

# 后续指令会继续在当前任务上下文中执行
> 继续，把表格导出为 Excel
→ 正在执行任务 #task_abc123...
✓ 任务完成 (5.2s)

# 查看任务
/tasks              # 所有任务
/tasks active       # 活跃任务
/tasks ready        # 待执行任务
/tasks parked       # 已挂起任务
/tasks blocked      # 阻塞任务

# 任务操作
/task <id>          # 查看详情
/task <id> pause    # 暂停
/task <id> resume   # 恢复
/task <id> block 等待客户资料  # 标记阻塞
/task <id> unblock  # 解除阻塞
/task <id> unblock /tmp/evidence-v3.pdf  # 解除阻塞并附带新材料
/task <id> done     # 完成
```

### 偏好记忆与自动提取

```bash
# 系统自动观察重复模式
> 用正式语气回复张总
[执行...]

> 用正式语气回复李总
[执行...]

> 用正式语气回复王总
[执行...]
💡 检测到重复模式（3次）："用正式语气"
   要记为长期偏好吗？输入 /memory confirm obs_123

# 确认后，后续任务会自动注入该偏好
/memory confirm obs_123
已确认偏好 #pref_abc: 用正式语气

# 查看偏好
/memory             # 已确认偏好
/memory candidates  # 待确认偏好（出现3次后）

# 手动添加
/memory add 张总偏好正式语气，必须抄送法务

# 搜索和删除
/memory search 正式
/memory delete <pref_id>
```

### 任务盘面

```bash
/dashboard          # 显示优先级排序、阻塞任务、建议
```

## 工作流程

### 完整执行流程

1. **用户输入自然语言** → 创建任务对象
2. **任务状态迁移** → CREATED → READY → RUNNING
3. **偏好召回** → 根据关键词匹配相关偏好
4. **上下文注入** → 将任务目标、已完成进度、偏好注入执行器
5. **调用默认执行器（Codex CLI）** → 通过 CLI 子进程执行
6. **结果回流** → 更新任务摘要、标记完成
7. **模式观察** → 提取重复模式，达到 3 次提示确认
8. **主动建议** → 推荐下一个优先任务

### 偏好生命周期

```
用户输入包含模式
  ↓
observations 表记录（第 1 次）
  ↓
重复出现（第 2 次）
  ↓
达到阈值（第 3 次）→ 提示用户确认
  ↓
用户确认 → preferences 表（status=confirmed）
  ↓
后续任务自动召回并注入执行器
```

### 任务连续性

```
任务执行中 → 用户切换 → park（生成快照）
  ↓
快照保存：done/pending/nextStep/pauseReason
  ↓
恢复时 → 读取快照 → 生成恢复摘要
  ↓
继续执行 → 上下文无缝衔接
```

## 技术架构

```
src/
├── core/           # 核心引擎
│   ├── types.ts           # 类型定义
│   ├── task-engine.ts     # 任务状态机、快照、恢复
│   ├── memory-engine.ts   # 偏好观察、确认、召回
│   └── orchestration.ts   # 优先级评分、盘面生成
├── storage/        # 数据层
│   ├── database.ts        # SQLite 初始化
│   ├── migrations.ts      # Schema 迁移
│   ├── task-repo.ts       # 任务数据访问
│   ├── preference-repo.ts # 偏好数据访问
│   └── observation-repo.ts # 观察记录
├── executor/       # 执行器适配
│   ├── adapter.ts         # 抽象接口
│   ├── codex-cli.ts       # Codex CLI 适配器（默认）
│   └── claude-code.ts     # Claude Code CLI 适配器（兼容保留）
├── commands/       # 命令系统
│   ├── router.ts          # 斜杠命令路由
│   ├── task-commands.ts   # 任务命令
│   ├── memory-commands.ts # 偏好命令
│   └── global-commands.ts # 全局命令
├── tui/            # 终端界面
│   └── app.tsx            # ink 组件
└── utils/          # 工具
    ├── config.ts          # 配置加载
    ├── logger.ts          # 日志
    └── id.ts              # ID 生成
```

## 配置

编辑 `~/.metaclaw/config.yaml`：

```yaml
version: 1

executor:
  command: codex           # 默认执行器；可改为 claude
  timeout: 300             # 执行超时（秒）

orchestration:
  reminder_enabled: true   # 是否启用主动提醒
  reminder_throttle: 300   # 提醒最小间隔（秒）
  top_k_preferences: 5     # 偏好召回数量上限

ui:
  language: zh-CN          # 界面语言
  dashboard_on_start: true # 启动时显示盘面
```

## 开发

```bash
# 开发模式（监听文件变化）
npm run dev

# 脚本化用户流烟测
node dist/index.js --script /tmp/metaclaw-flow.txt

# 运行测试
npm test

# 类型检查
npm run lint

# 构建
npm run build
```

## 测试

```bash
npm test                # 运行所有测试
npm run test:watch      # 监听模式
```

试用案例见：

- `examples/trial-scenarios/README.md`
- `examples/trial-scenarios/scripts/`
- `examples/trial-scenarios/manual/`

当前测试覆盖：
- TaskEngine：状态机、挂起/恢复、阻塞/解除、资源关联
- MemoryEngine：三次确认、偏好召回、作用域优先级
- OrchestrationEngine：优先级评分、盘面生成、建议生成

## 设计文档

- [PRD V2](docs/metaclaw-os_prd_v2.md) — 产品需求、场景、验收标准
- [技术设计 V1](docs/metaclaw-os_tech_design_v1.md) — 数据模型、状态机、执行器方案
- [TUI 规范 V1](docs/metaclaw-os_tui_spec_v1.md) — 交互规范、命令体系
- [实施方案 V1](docs/metaclaw-os_implementation_v1.md) — 技术栈、模块设计、分阶段路线

## 许可

MIT
