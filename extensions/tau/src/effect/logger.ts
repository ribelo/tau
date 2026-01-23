import { Logger, LogLevel } from "effect";

export const PiLoggerLive = Logger.replace(
	Logger.defaultLogger,
	Logger.make(({ logLevel, message }) => {
		const msg = Array.isArray(message) ? message.join(" ") : String(message);
		const timestamp = new Date().toISOString();
		if (logLevel === LogLevel.None) return;
		console.log(`[${timestamp}] [${logLevel.label}] ${msg}`);
	}),
);
