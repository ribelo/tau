import { Logger } from "effect";

const piLogger = Logger.make(({ logLevel, message, date }) => {
	const msg = Array.isArray(message) ? message.join(" ") : String(message);
	if (logLevel === "Error" || logLevel === "Warn") {
		const timestamp = date.toISOString();
		console.log(`[${timestamp}] [${logLevel}] ${msg}`);
	}
});

export const PiLoggerLive = Logger.layer([piLogger]);
