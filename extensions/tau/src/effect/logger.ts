import { Logger, LogLevel } from "effect";

export const PiLoggerLive = Logger.replace(
	Logger.defaultLogger,
	Logger.make(({ logLevel, message }) => {
		const msg = Array.isArray(message) ? message.join(" ") : String(message);
		// Only log to console if it's an error or warning, or if we are in a debug mode.
		// For now, let's keep it silent for INFO to avoid TUI pollution.
		if (logLevel === LogLevel.Error || logLevel === LogLevel.Warning) {
			const timestamp = new Date().toISOString();
			console.log(`[${timestamp}] [${logLevel.label}] ${msg}`);
		}
	}),
);
