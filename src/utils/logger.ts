import pino from 'pino';

/**
 * 全局日志实例
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

/**
 * 创建子日志器
 */
export function createLogger(name: string) {
  return logger.child({ module: name });
}
