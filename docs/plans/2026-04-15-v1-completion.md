# Metaclaw V1 Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 以最短关键路径补齐 Metaclaw 的 V1 验收项，让项目从“能跑的原型”收口为“可宣称完成的 V1”。

**Architecture:** 保持现有单进程、本地 SQLite、单执行器、单文件 TUI 架构不变，优先做缺口补齐和行为修正，不做组件化重构。先修工程红线和 PRD 必达项，再补命令对齐、打断恢复、偏好门控、配置接线，最后更新文档与回归测试。

**Tech Stack:** TypeScript, Node.js 20, Ink 5, React 18, better-sqlite3, Vitest, tsup

---

## Delivery Strategy

### Scope Rules

- 保留现有 `src/tui/app.tsx` 单文件结构直到 V1 收尾完成，不在本轮拆 `components/` 和 `hooks/`
- 不引入新数据库表，优先复用 `tasks` / `preferences` / `observations` / `interactions` / `preference_usage`
- 不做多执行器、daemon、文件系统 watcher、自动唤醒
- 高风险动作只做最小确认门控，不做复杂审批流

### Priority Order

1. 工程红线清零：`npm run lint`、`npm test`、`npm run build`
2. PRD 必达项缺口：挂起/恢复/阻塞/盘面/偏好确认/偏好编辑/注入透明
3. TUI 关键体验：运行中打断、自然语言暂停/继续/记住/现在该做什么
4. 文档与 README 对齐，形成可演示闭环

---

### Task 1: 收口工程基线并建立 V1 缺口测试

**Files:**
- Modify: `src/core/context-recaller.ts`
- Modify: `src/executor/adapter.ts`
- Modify: `src/core/types.ts`
- Modify: `tests/core/context-recaller.test.ts`
- Create: `tests/commands/router-intent.test.ts`

**Step 1: 写出缺口测试，先覆盖当前类型与命令缺口**

```ts
import { describe, it, expect } from 'vitest';

describe('V1 gap baseline', () => {
  it('允许 llm 召回来源通过类型检查', () => {
    const source: 'task' | 'session' | 'keyword' | 'llm' = 'llm';
    expect(source).toBe('llm');
  });
});
```

**Step 2: 跑类型检查确认当前失败**

Run: `npm run lint`
Expected: FAIL，包含 `Argument of type '"llm"' is not assignable`

**Step 3: 最小修复类型定义**

```ts
export interface ConversationTurn {
  taskId: string;
  userInput: string;
  systemOutput: string;
  createdAt: string;
  source: 'task' | 'session' | 'keyword' | 'llm';
}
```

**Step 4: 跑基础校验**

Run: `npm run lint`
Expected: PASS

**Step 5: 提交**

```bash
git add src/core/context-recaller.ts src/executor/adapter.ts src/core/types.ts tests/core/context-recaller.test.ts tests/commands/router-intent.test.ts
git commit -m "fix: restore type-safe recall sources"
```

---

### Task 2: 补齐文档声明但未实现的命令面

**Files:**
- Modify: `src/commands/global-commands.ts`
- Modify: `src/commands/memory-commands.ts`
- Modify: `src/commands/router.ts`
- Modify: `src/tui/app.tsx`
- Create: `tests/commands/global-commands-full.test.ts`
- Create: `tests/commands/memory-commands.test.ts`

**Step 1: 为缺失命令写失败测试**

```ts
it('supports /history and /config in help output', async () => {
  expect(helpText).toContain('/history');
  expect(helpText).toContain('/config');
});

it('supports /memory edit', async () => {
  const result = await memoryCommand.execute(['edit', prefId, '新内容'], ctx);
  expect(result.content).toContain('已更新偏好');
});
```

**Step 2: 跑命令测试确认失败**

Run: `npm test -- tests/commands/global-commands-full.test.ts tests/commands/memory-commands.test.ts`
Expected: FAIL，提示未知命令或默认分支

**Step 3: 实现最小命令闭环**

```ts
case 'edit': {
  const prefId = args[1];
  const content = args.slice(2).join(' ');
  const updated = context.memoryEngine.update(prefId, { content });
  return { type: 'text', content: `已更新偏好 #${updated.id}: ${updated.content}` };
}
```

```ts
export const historyCommand: CommandHandler = {
  name: 'history',
  aliases: [],
  description: '查看交互历史',
  async execute(args, context) {
    const rows = context.db.prepare(
      'SELECT task_id, user_input, created_at FROM interactions ORDER BY created_at DESC LIMIT 10'
    ).all();
    return { type: 'text', content: rows.length ? rows.map(formatRow).join('\n') : '暂无交互历史' };
  },
};
```

```ts
export const configCommand: CommandHandler = {
  name: 'config',
  aliases: [],
  description: '查看当前配置',
  async execute(args, context) {
    return { type: 'text', content: YAML.stringify(context.config) };
  },
};
```

**Step 4: 让 App 注册新命令并传入 `db` / `config`**

```ts
const result = await router.execute(userInput, {
  taskEngine,
  memoryEngine,
  orchestration,
  executor,
  currentTaskId,
  db,
  config,
});
```

**Step 5: 跑命令测试**

Run: `npm test -- tests/commands/global-commands-full.test.ts tests/commands/memory-commands.test.ts`
Expected: PASS

**Step 6: 提交**

```bash
git add src/commands/global-commands.ts src/commands/memory-commands.ts src/commands/router.ts src/tui/app.tsx tests/commands/global-commands-full.test.ts tests/commands/memory-commands.test.ts
git commit -m "feat: complete v1 slash command surface"
```

---

### Task 3: 修正偏好生命周期，补齐“查看/确认/修改/删除/来源透明”

**Files:**
- Modify: `src/core/memory-engine.ts`
- Modify: `src/storage/preference-repo.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/commands/memory-commands.ts`
- Create: `tests/core/memory-engine-v1.test.ts`

**Step 1: 先写失败测试，覆盖 V1 必达行为**

```ts
it('显式说记住时直接创建 confirmed 偏好', () => {
  const pref = engine.addManual({
    content: '张总用正式语气',
    scope: 'global',
    type: 'style',
  });
  expect(pref.status).toBe('confirmed');
});

it('注入偏好后记录 usage 和 lastUsedAt', () => {
  repo.recordUsage('pref_1', 'task_1');
  expect(repo.findById('pref_1')?.lastUsedAt).not.toBeNull();
});
```

**Step 2: 跑偏好测试确认失败**

Run: `npm test -- tests/core/memory-engine-v1.test.ts`
Expected: FAIL，至少有 usage 或直接确认路径未生效

**Step 3: 实现“记住”直存 confirmed**

```ts
if (rememberMatch) {
  const pref = memoryEngine.addManual({
    content: rememberMatch[1].trim(),
    scope: 'global',
    type: 'domain',
  });
  setOutput(prev => [...prev, `已记住偏好 #${pref.id}: ${pref.content}`]);
  return;
}
```

**Step 4: 在执行器注入后记录 usage，并输出注入透明信息**

```ts
for (const pref of preferences) {
  memoryEngine.recordUsage(pref.id, taskId);
}

setOutput(prev => [
  ...prev,
  `→ 已注入 ${preferences.length} 条偏好`,
  ...preferences.map(p => `  - [${p.scope}] ${p.content}`),
]);
```

**Step 5: 跑偏好相关测试**

Run: `npm test -- tests/core/memory-engine.test.ts tests/core/memory-engine-v1.test.ts`
Expected: PASS

**Step 6: 提交**

```bash
git add src/core/memory-engine.ts src/storage/preference-repo.ts src/tui/app.tsx src/commands/memory-commands.ts tests/core/memory-engine-v1.test.ts
git commit -m "feat: complete v1 preference lifecycle"
```

---

### Task 4: 实现自然语言控制映射，不再只会“新任务/引用任务”

**Files:**
- Modify: `src/core/llm-bridge.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/commands/task-commands.ts`
- Create: `tests/core/llm-bridge-intents.test.ts`
- Create: `tests/tui/natural-language-routing.test.ts`

**Step 1: 先写测试，覆盖暂停/继续/盘面/记住四类控制意图**

```ts
it('routes 暂停 to current task pause', async () => {
  const result = await resolveControlIntent('先暂停这个');
  expect(result.type).toBe('pause_current');
});

it('routes 现在该做什么 to dashboard', async () => {
  const result = await resolveControlIntent('现在该做什么');
  expect(result.type).toBe('show_dashboard');
});
```

**Step 2: 跑测试确认失败**

Run: `npm test -- tests/core/llm-bridge-intents.test.ts tests/tui/natural-language-routing.test.ts`
Expected: FAIL，当前没有控制意图分支

**Step 3: 先加规则判断，再保留 LLM fallback**

```ts
if (/^(暂停|先暂停|先放一下|回头继续)/.test(userInput)) {
  return { type: 'pause_current' };
}
if (/^(继续|继续刚才的|恢复刚才的)/.test(userInput)) {
  return { type: 'resume_recent' };
}
if (/^(现在该做什么|看看盘面|dashboard)/.test(userInput)) {
  return { type: 'show_dashboard' };
}
```

**Step 4: 在 TUI 中执行控制动作而不是创建新任务**

```ts
if (controlIntent.type === 'pause_current' && currentTaskId) {
  const result = await taskCommand.execute([currentTaskId, 'pause'], ctx);
  setOutput(prev => [...prev, result.content]);
  return;
}
```

**Step 5: 跑测试**

Run: `npm test -- tests/core/llm-bridge-intents.test.ts tests/tui/natural-language-routing.test.ts`
Expected: PASS

**Step 6: 提交**

```bash
git add src/core/llm-bridge.ts src/tui/app.tsx src/commands/task-commands.ts tests/core/llm-bridge-intents.test.ts tests/tui/natural-language-routing.test.ts
git commit -m "feat: support natural language control intents"
```

---

### Task 5: 打通运行中打断、挂起、切换、恢复的关键体验

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/executor/claude-code.ts`
- Modify: `src/executor/adapter.ts`
- Modify: `src/core/task-engine.ts`
- Create: `tests/executor/abort-flow.test.ts`
- Create: `tests/core/task-engine-interrupt.test.ts`

**Step 1: 先写失败测试，覆盖执行中中断**

```ts
it('aborts running executor and parks task', async () => {
  await interruptCurrentTask();
  expect(abortSpy).toHaveBeenCalled();
  expect(task.status).toBe('parked');
});
```

**Step 2: 跑测试确认失败**

Run: `npm test -- tests/executor/abort-flow.test.ts tests/core/task-engine-interrupt.test.ts`
Expected: FAIL，当前 UI 不会调用 `abort()`

**Step 3: 在 TUI 中增加运行中控制分支**

```ts
if (isExecuting && /^(暂停|中断|停一下)/.test(userInput) && currentTaskId) {
  executor.abort();
  taskEngine.park(currentTaskId, '用户中断当前执行', {
    done: [task.summary || '执行已被中断'],
    pending: ['等待恢复'],
    nextStep: '恢复后继续执行',
    pauseReason: '用户中断当前执行',
  });
  setIsExecuting(false);
  return;
}
```

**Step 4: 在执行失败/中断路径保持快照而不是裸转 parked**

```ts
taskEngine.park(taskId, '执行器异常或用户中断', {
  done: [task.summary || '部分执行完成'],
  pending: ['等待用户恢复'],
  nextStep: '检查输出后继续',
  pauseReason: '执行器异常或用户中断',
});
```

**Step 5: 跑中断相关测试**

Run: `npm test -- tests/executor/abort-flow.test.ts tests/core/task-engine-interrupt.test.ts`
Expected: PASS

**Step 6: 提交**

```bash
git add src/tui/app.tsx src/executor/claude-code.ts src/executor/adapter.ts src/core/task-engine.ts tests/executor/abort-flow.test.ts tests/core/task-engine-interrupt.test.ts
git commit -m "feat: support interrupt and resume workflow"
```

---

### Task 6: 补齐配置接线和提醒节流，满足 PRD “可配置、可节流”

**Files:**
- Modify: `src/index.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/core/orchestration.ts`
- Modify: `src/commands/router.ts`
- Create: `tests/core/orchestration-throttle.test.ts`
- Create: `tests/tui/config-wiring.test.ts`

**Step 1: 写测试覆盖配置行为**

```ts
it('respects top_k_preferences from config', () => {
  expect(recalled).toHaveLength(2);
});

it('skips startup dashboard when dashboard_on_start is false', () => {
  expect(lines[0]).not.toContain('Metaclaw v1.0');
});
```

**Step 2: 跑测试确认失败**

Run: `npm test -- tests/core/orchestration-throttle.test.ts tests/tui/config-wiring.test.ts`
Expected: FAIL，当前配置未接线

**Step 3: 把 config 注入 TUI 和引擎调用**

```ts
const preferences = memoryEngine.recall({
  taskId,
  keywords,
  topK: config.orchestration.top_k_preferences,
});
```

```ts
if (config.ui.dashboard_on_start) {
  setOutput(lines);
}
```

**Step 4: 做最小提醒节流**

```ts
if (!config.orchestration.reminder_enabled) return null;
if (Date.now() - lastReminderAt < config.orchestration.reminder_throttle * 1000) return null;
```

**Step 5: 跑配置相关测试**

Run: `npm test -- tests/core/orchestration-throttle.test.ts tests/tui/config-wiring.test.ts`
Expected: PASS

**Step 6: 提交**

```bash
git add src/index.ts src/tui/app.tsx src/core/orchestration.ts src/commands/router.ts tests/core/orchestration-throttle.test.ts tests/tui/config-wiring.test.ts
git commit -m "feat: wire v1 runtime configuration"
```

---

### Task 7: 补最小高风险确认门控，防止违反 PRD

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/core/types.ts`
- Create: `tests/tui/risky-action-gate.test.ts`

**Step 1: 写失败测试**

```ts
it('requires confirmation for risky external message prompts', async () => {
  const result = await handleInput('直接把邮件发给客户');
  expect(result).toContain('需要确认');
});
```

**Step 2: 跑测试确认失败**

Run: `npm test -- tests/tui/risky-action-gate.test.ts`
Expected: FAIL，当前会直接执行

**Step 3: 实现最小门控**

```ts
if (/(发送邮件|发给客户|直接提交|对外发送|法务提交|财务提交)/.test(userInput) && !pendingRiskConfirmation) {
  setPendingRiskConfirmation(userInput);
  setOutput(prev => [...prev, '⚠️ 这是高风险动作，输入 “确认执行” 后继续。']);
  return;
}
```

**Step 4: 跑风险门控测试**

Run: `npm test -- tests/tui/risky-action-gate.test.ts`
Expected: PASS

**Step 5: 提交**

```bash
git add src/tui/app.tsx src/core/types.ts tests/tui/risky-action-gate.test.ts
git commit -m "feat: add v1 risky action confirmation gate"
```

---

### Task 8: README、Spec、帮助文本、演示路径全部对齐

**Files:**
- Modify: `README.md`
- Modify: `docs/metaclaw-os_tui_spec_v1.md`
- Modify: `docs/metaclaw-os_implementation_v1.md`
- Modify: `src/commands/global-commands.ts`

**Step 1: 更新 README 为真实现状和真实命令集**

```md
- `/history`：查看最近交互
- `/config`：查看当前配置
- 自然语言支持：暂停、继续、记住、现在该做什么
```

**Step 2: 更新 spec 中与实现不一致的示例**

Run: `rg -n "/history|/config|/memory edit|继续刚才的|确认执行" README.md docs src/commands/global-commands.ts`
Expected: 所有文案一致

**Step 3: 跑全量验证**

Run: `npm run lint`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npm run build`
Expected: PASS

**Step 4: 提交**

```bash
git add README.md docs/metaclaw-os_tui_spec_v1.md docs/metaclaw-os_implementation_v1.md src/commands/global-commands.ts
git commit -m "docs: align v1 docs with shipped behavior"
```

---

## Exit Criteria

- `npm run lint` 通过
- `npm test` 通过
- `npm run build` 通过
- `/tasks /task /dashboard /attach /history /config /memory add/edit/delete/candidates/confirm/reject/stats` 全部可用
- 自然语言支持：创建任务、暂停当前任务、继续最近任务、展示盘面、显式“记住”
- 运行中可以中断并生成可恢复快照
- 偏好注入有可见输出，且记录 usage / lastUsedAt
- 高风险外发动作有最小确认门控
- README 与 TUI 帮助文本一致

## Recommended Execution Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6
7. Task 7
8. Task 8

## Explicit Deferrals

- 不拆分 `src/tui/app.tsx`
- 不实现 GUI 版本
- 不做自动唤醒、文件监听、时间触发
- 不做多执行器路由
- 不做向量召回

Plan complete and saved to `docs/plans/2026-04-15-v1-completion.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
