import { resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { createDatabase } from './storage/database.js';
import { TaskRepo } from './storage/task-repo.js';
import { PreferenceRepo } from './storage/preference-repo.js';
import { ObservationRepo } from './storage/observation-repo.js';
import { TaskMemoryCardRepo } from './storage/task-memory-card-repo.js';
import { TaskEngine } from './core/task-engine.js';
import { MemoryEngine } from './core/memory-engine.js';
import { OrchestrationEngine } from './core/orchestration.js';
import { createExecutor } from './executor/factory.js';
import { ContextRecaller } from './core/context-recaller.js';
import { LlmBridge } from './core/llm-bridge.js';
import { loadConfig, migrateLegacyFeishuConfigFileToGateway } from './utils/config.js';
import { resolveMetaclawDir } from './utils/paths.js';
import { renderApp } from './tui/app.js';
import { parseCliArgs } from './cli/args.js';
import { runScriptedSessionFile } from './session/scripted-session.js';
import { createNotificationService } from './notifications/feishu.js';
import { nanoid } from 'nanoid';
import { MetaclawGatewayServer } from './gateway/server.js';
import { runGatewayClientUi } from './gateway/client-ui.js';
import { resolveGatewaySocketPath } from './gateway/gateway-paths.js';
import { MarkdownPreviewServer } from './integrations/markdown-preview.js';
import { runGatewaySetup } from './gateway/setup.js';
import { startFeishuRuntimeBridge } from './gateway/feishu-runtime.js';

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  // 1. 初始化目录
  const metaclawDir = resolveMetaclawDir();
  const snapshotDir = resolve(metaclawDir, 'snapshots');
  const gatewaySocketPath = resolveGatewaySocketPath(metaclawDir);
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });

  if (cliArgs.connect) {
    await runGatewayClientUi(gatewaySocketPath);
    return;
  }

  if (cliArgs.gatewayCommand === 'setup') {
    await runGatewaySetup({ metaclawDir });
    return;
  }

  if (
    cliArgs.gatewayCommand === 'start'
    || cliArgs.gatewayCommand === 'stop'
    || cliArgs.gatewayCommand === 'restart'
    || cliArgs.gatewayCommand === 'status'
  ) {
    console.log(`请使用 ./metaclaw.sh ${cliArgs.gatewayCommand} 管理后台进程。`);
    return;
  }

  // 2. 加载配置
  const configPath = resolve(metaclawDir, 'config.yaml');
  migrateLegacyFeishuConfigFileToGateway(configPath);
  const config = loadConfig(configPath);
  const markdownPreviewConfig = config.integrations?.markdown_preview;
  const markdownPreviewServer = markdownPreviewConfig?.enabled
    ? new MarkdownPreviewServer(markdownPreviewConfig, process.cwd())
    : null;
  if (markdownPreviewServer && markdownPreviewConfig) {
    try {
      await markdownPreviewServer.start();
      const markdownPreviewBaseUrl = (markdownPreviewConfig.public_base_url
        ?? `http://${markdownPreviewConfig.host}:${markdownPreviewConfig.port}`).replace(/\/+$/, '');
      console.log(
        `Markdown preview listening: ${markdownPreviewBaseUrl}`,
      );
    } catch (error) {
      console.error(`Markdown preview start failed: ${(error as Error).message}`);
    }
  }

  // 3. 初始化数据库
  const db = createDatabase(resolve(metaclawDir, 'metaclaw.db'));

  // 4. 初始化 Repos
  const taskRepo = new TaskRepo(db);
  const prefRepo = new PreferenceRepo(db);
  const obsRepo = new ObservationRepo(db);

  const taskMemoryCardRepo = new TaskMemoryCardRepo(db);

  // 5. 初始化执行器语义桥接
  const llmBridge = new LlmBridge(config.executor.command);

  // 6. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const memoryEngine = new MemoryEngine(prefRepo, obsRepo, undefined, undefined, taskMemoryCardRepo, llmBridge);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 7. 初始化执行器
  const executor = createExecutor({
    command: config.executor.command,
    timeout: config.executor.timeout,
    maxDuration: config.executor.max_duration,
    workspaceRoot: process.cwd(),
  });

  // 8. 检查执行器可用性
  if (!(await executor.isAvailable())) {
    console.error(`错误：未找到 ${config.executor.command} 命令。请先安装对应执行器。`);
    process.exit(1);
  }

  // 9. 初始化上下文召回器
  const sessionId = `sess_${nanoid(10)}`;
  const contextRecaller = new ContextRecaller(db, llmBridge);
  const notifier = createNotificationService(config);

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
      notifier,
    });
    if (result.output.length > 0) {
      process.stdout.write(`${result.output.join('\n')}\n`);
    }
    return;
  }

  const gatewayServer = new MetaclawGatewayServer({
    socketPath: gatewaySocketPath,
    taskEngine,
    memoryEngine,
    orchestration,
    db,
    config,
    contextRecaller,
    llmBridge,
    notifier,
    workspaceRoot: process.cwd(),
  });

  await gatewayServer.start();
  let gatewayFeishuBridge: Awaited<ReturnType<typeof startFeishuRuntimeBridge>> = null;
  if (cliArgs.gateway) {
    const gatewaySession = new (await import('./session/metaclaw-session.js')).MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config,
      sessionId,
      contextRecaller,
      llmBridge,
      notifier,
    });
    gatewaySession.initialize({ resumeStartupTasks: false, showDashboard: false });
    gatewayFeishuBridge = await startFeishuRuntimeBridge(config, gatewaySession);
  }
  process.once('exit', () => {
    void gatewayFeishuBridge?.stop();
    void markdownPreviewServer?.stop();
    void gatewayServer.stop();
  });
  process.once('SIGINT', () => {
    void Promise.all([
      gatewayFeishuBridge?.stop() ?? Promise.resolve(),
      gatewayServer.stop(),
      markdownPreviewServer?.stop() ?? Promise.resolve(),
    ]).finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void Promise.all([
      gatewayFeishuBridge?.stop() ?? Promise.resolve(),
      gatewayServer.stop(),
      markdownPreviewServer?.stop() ?? Promise.resolve(),
    ]).finally(() => process.exit(0));
  });

  if (cliArgs.gateway) {
    console.log(`Metaclaw Gateway listening: ${gatewaySocketPath}`);
    await new Promise(() => undefined);
    return;
  }

  // 9. 启动 TUI
  renderApp({ taskEngine, memoryEngine, orchestration, executor, db, config, sessionId, contextRecaller, llmBridge, notifier });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
