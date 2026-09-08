import { pino } from 'pino';

import { loadEnv } from '../config/env.js';

export function createLogger() {
  const env = loadEnv();
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'remittance-backend' },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;