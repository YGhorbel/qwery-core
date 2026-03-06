import { Logger as LoggerInstance } from './logger';

const LOGGER =
  typeof globalThis !== 'undefined' && globalThis.process?.env?.LOGGER
    ? 'pino'
    : 'console';

export async function getLogger(): Promise<LoggerInstance> {
  switch (LOGGER) {
    case 'pino': {
      const { getPinoLogger } = await import('./impl/pino');

      return getPinoLogger();
    }

    case 'console': {
      const { Logger: ConsoleLogger } = await import('./impl/console');

      return ConsoleLogger;
    }

    default:
      throw new Error(`Unknown logger: ${LOGGER}`);
  }
}

export default { getLogger };
