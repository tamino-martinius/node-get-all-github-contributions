export const logLevels = ["debug", "log", "warn", "error", "none"] as const;
export type LogLevel = (typeof logLevels)[number];
export type LoggableLevel = Exclude<LogLevel, "none">;
export const isLogLevel = (level: unknown): level is LogLevel => {
	return typeof level === "string" && logLevels.includes(level as LogLevel);
};
