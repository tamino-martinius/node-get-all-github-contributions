import {
	isLogLevel,
	type LoggableLevel,
	type LogLevel,
	logLevels,
} from "./types/Logger";

const logLevelFromEnv = process.env.LOG_LEVEL;
const logLevel: LogLevel = isLogLevel(logLevelFromEnv)
	? logLevelFromEnv
	: "error";

const shouldLog = (level: LogLevel) => {
	return logLevels.indexOf(level) >= logLevels.indexOf(logLevel);
};

type LoggableMessage = Parameters<(typeof console)[LoggableLevel]>;

export const Logger: Record<
	LoggableLevel,
	(...args: LoggableMessage) => void
> & {
	send: (messages: Partial<Record<LoggableLevel, LoggableMessage>>) => void;
} = {
	...logLevels.reduce(
		(acc, level) => {
			acc[level] = (...args: Parameters<(typeof console)[LoggableLevel]>) => {
				if (level === "none") return;
				if (shouldLog(level)) {
					console[level](`[${level.substring(0, 3).toUpperCase()}]`, ...args);
				}
			};
			return acc;
		},
		{} as Record<
			LogLevel,
			(...args: Parameters<(typeof console)[LoggableLevel]>) => void
		>,
	),
	send: (messages) => {
		for (const level of logLevels) {
			if (level !== "none" && shouldLog(level) && messages[level]) {
				console[level](
					`[${level.substring(0, 3).toUpperCase()}]`,
					...messages[level],
				);
				return;
			}
		}
	},
};
