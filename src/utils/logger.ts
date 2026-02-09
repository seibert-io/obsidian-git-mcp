type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: string): void {
  if (level in LOG_LEVELS) {
    currentLevel = level as LogLevel;
  }
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const base = `${timestamp} [${level.toUpperCase()}] ${message}`;
  if (context && Object.keys(context).length > 0) {
    return `${base} ${JSON.stringify(context)}`;
  }
  return base;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("debug")) {
      console.debug(formatMessage("debug", message, context));
    }
  },
  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("info")) {
      console.info(formatMessage("info", message, context));
    }
  },
  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("warn")) {
      console.warn(formatMessage("warn", message, context));
    }
  },
  error(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message, context));
    }
  },
};
