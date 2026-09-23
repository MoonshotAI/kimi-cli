/**
 * Logging module — corresponds to Python utils/logging.py
 * Disk-only logger using log4js. Writes to session logs directory only,
 * never to stdout/stderr.
 */

import log4js from "log4js";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

// log4js logger instance — initialized lazily when setLogDir is called
let log4jsLogger: log4js.Logger | null = null;

class Logger {
	private level: LogLevel = "info";
	private logDir: string | null = null;
	private buffer: Array<{ level: LogLevel; message: string }> = [];

	setLevel(level: LogLevel): void {
		this.level = level;
		if (log4jsLogger) {
			log4jsLogger.level = level;
		}
	}

	/**
	 * Set the directory where logs will be written.
	 * Configures log4js with a file appender and flushes buffered logs.
	 */
	setLogDir(dir: string): void {
		this.logDir = dir;
		const logFile = join(dir, "logs.log");

		log4js.configure({
			appenders: {
				file: {
					type: "file",
					filename: logFile,
					maxLogSize: 5 * 1024 * 1024, // 5MB
					backups: 1,
					layout: {
						type: "pattern",
						pattern: "[%d{yyyy-MM-dd hh:mm:ss.SSS}] [%p] %m",
					},
				},
			},
			categories: {
				default: { appenders: ["file"], level: this.level },
			},
			disableClustering: true,
		});

		log4jsLogger = log4js.getLogger("kimi");
		log4jsLogger.level = this.level;

		// Flush buffered log entries
		for (const entry of this.buffer) {
			log4jsLogger[entry.level](entry.message);
		}
		this.buffer = [];
	}

	private _log(level: LogLevel, message: string, args: unknown[]): void {
		if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;

		const fullMessage = `${message}${args.length ? " " + args.map(String).join(" ") : ""}`;

		if (!log4jsLogger) {
			// Buffer until log dir is set
			this.buffer.push({ level, message: fullMessage });
			return;
		}

		log4jsLogger[level](fullMessage);
	}

	debug(message: string, ...args: unknown[]): void {
		this._log("debug", message, args);
	}

	info(message: string, ...args: unknown[]): void {
		this._log("info", message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this._log("warn", message, args);
	}

	error(message: string, ...args: unknown[]): void {
		this._log("error", message, args);
	}
}

export const logger = new Logger();

// Set default level from environment
if (process.env.KIMI_LOG_LEVEL) {
	const envLevel = process.env.KIMI_LOG_LEVEL.toLowerCase() as LogLevel;
	if (envLevel in LOG_LEVELS) {
		logger.setLevel(envLevel);
	}
}
