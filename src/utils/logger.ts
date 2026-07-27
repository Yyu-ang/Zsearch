/**
 * Zsearch unified logger.
 *
 * 规整插件调试输出格式，所有日志统一前缀 `[Zsearch]` 并分级。
 * 使用方式：
 *   import { logger } from "../utils/logger";
 *   logger.info("started");
 *   logger.error("failed", err);
 *
 * 日志级别通过环境变量或 pref 控制，production 环境下 debug 日志被抑制。
 */

import { config } from "../../package.json";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

function formatParts(level: LogLevel, scope: string, msg: unknown, extra?: unknown[]): string {
  const head = `[${nowStamp()}] [Zsearch] [${LEVEL_TAG[level]}]`;
  const scopeTag = scope ? `[${scope}]` : "";
  const msgStr = typeof msg === "string" ? msg : safeStringify(msg);
  const tail = extra && extra.length > 0
    ? " " + extra.map((x) => (typeof x === "string" ? x : safeStringify(x))).join(" ")
    : "";
  return `${head}${scopeTag} ${msgStr}${tail}`;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) {
    return `${v.message}\n${v.stack ?? ""}`;
  }
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

class Logger {
  /** 当前最小输出级别（低于此级别被丢弃）。默认 debug，production 下 info。 */
  private minLevel: LogLevel = __env__ === "production" ? "info" : "debug";
  private prefix = `[${config.addonName}]`;

  /** 临时调整级别（如通过 pref 控制）。 */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  private emit(level: LogLevel, scope: string, msg: unknown, extra?: unknown[]): void {
    if (!this.enabled(level)) return;
    const line = formatParts(level, scope, msg, extra);
    // 优先使用 Zotero.debug（出现在 Zotero 日志面板）
    try {
      Zotero.debug(line);
    } catch {
      /* ignore */
    }
    // 也写入控制台便于 serve 模式调试
    try {
      const fn =
        level === "error"
          ? console.error
          : level === "warn"
            ? console.warn
            : level === "debug"
              ? console.debug
              : console.log;
      fn.call(console, line);
    } catch {
      /* ignore */
    }
    // 备份：ztoolkit log（兼容 toolkit 日志路径）
    try {
      ztoolkit?.log?.(line);
    } catch {
      /* ignore */
    }
  }

  debug(scope: string, msg: unknown, ...extra: unknown[]): void {
    this.emit("debug", scope, msg, extra);
  }
  info(scope: string, msg: unknown, ...extra: unknown[]): void {
    this.emit("info", scope, msg, extra);
  }
  warn(scope: string, msg: unknown, ...extra: unknown[]): void {
    this.emit("warn", scope, msg, extra);
  }
  error(scope: string, msg: unknown, ...extra: unknown[]): void {
    this.emit("error", scope, msg, extra);
  }

  /** 作用域绑定：返回固定 scope 的子 logger。 */
  scoped(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope);
  }
}

class ScopedLogger {
  constructor(private parent: Logger, private scope: string) {}
  debug(msg: unknown, ...extra: unknown[]): void {
    this.parent.debug(this.scope, msg, ...extra);
  }
  info(msg: unknown, ...extra: unknown[]): void {
    this.parent.info(this.scope, msg, ...extra);
  }
  warn(msg: unknown, ...extra: unknown[]): void {
    this.parent.warn(this.scope, msg, ...extra);
  }
  error(msg: unknown, ...extra: unknown[]): void {
    this.parent.error(this.scope, msg, ...extra);
  }
}

/** 单例 logger，全插件共用。 */
export const logger = new Logger();

/** 常用作用域 logger。 */
export const log = {
  startup: logger.scoped("STARTUP"),
  shutdown: logger.scoped("SHUTDOWN"),
  menu: logger.scoped("MENU"),
  toolbar: logger.scoped("TOOLBAR"),
  search: logger.scoped("SEARCH"),
  import: logger.scoped("IMPORT"),
  pdf: logger.scoped("PDF"),
  api: logger.scoped("API"),
  prefs: logger.scoped("PREFS"),
  column: logger.scoped("COLUMN"),
  hooks: logger.scoped("HOOKS"),
};
