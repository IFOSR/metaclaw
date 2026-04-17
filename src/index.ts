import { resolve } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createDatabase } from './storage/database.js';
import { TaskRepo } from './storage/task-repo.js';
import { PreferenceRepo } from './storage/preference-repo.js';
import { ObservationRepo } from './storage/observation-repo.js';
import { TaskEngine } from './core/task-engine.js';
import { MemoryEngine } from './core/memory-engine.js';
import { OrchestrationEngine } from './core/orchestration.js';
import { createExecutor } from './executor/factory.js';
import { ContextRecaller } from './core/context-recaller.js';
import { LlmBridge } from './core/llm-bridge.js';
import { loadConfig } from './utils/config.js';
import { renderApp } from './tui/app.js';
import { parseCliArgs } from './cli/args.js';
import { runScriptedSessionFile } from './session/scripted-session.js';
import { nanoid } from 'nanoid';

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  // 1. 初始化目录
  const metaclawDir = resolve(homedir(), '.metaclaw');
  const snapshotDir = resolve(metaclawDir, 'snapshots');
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });

  // 2. 加载配置
  const config = loadConfig(resolve(metaclawDir, 'config.yaml'));

  // 3. 初始化数据库
  const db = createDatabase(resolve(metaclawDir, 'metaclaw.db'));

  // 4. 初始化 Repos
  const taskRepo = new TaskRepo(db);
  const prefRepo = new PreferenceRepo(db);
  const obsRepo = new ObservationRepo(db);

  // 5. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const memoryEngine = new MemoryEngine(prefRepo, obsRepo);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 6. 初始化执行器
  const executor = createExecutor({
    command: config.executor.command,
    timeout: config.executor.timeout,
    workspaceRoot: process.cwd(),
  });

  // 7. 检查执行器可用性
  if (!(await executor.isAvailable())) {
    console.error(`错误：未找到 ${config.executor.command} 命令。请先安装对应执行器。`);
    process.exit(1);
  }

  // 8. 初始化上下文召回器和 LLM 桥接
  const sessionId = `sess_${nanoid(10)}`;
  const llmBridge = new LlmBridge(config.executor.command);
  const contextRecaller = new ContextRecaller(db, llmBridge);

  if (cliArgs.scriptPath) {
    const result = await runScriptedSessionFile(cliArgs.scriptPath, {
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config,
      sessionId,
      contextRecaller,
      llmBridge,
    });
    if (result.output.length > 0) {
      process.stdout.write(`${result.output.join('\n')}\n`);
    }
    return;
  }

  // 9. 启动 TUI
  renderApp({ taskEngine, memoryEngine, orchestration, executor, db, config, sessionId, contextRecaller, llmBridge });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
