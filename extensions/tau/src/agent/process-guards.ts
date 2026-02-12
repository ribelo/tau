import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { closeAllAgents } from "./runtime.js";

interface ProcessGuardsState {
	installed: boolean;
	pi: ExtensionAPI | undefined;
	lastReportedAt: number;
	unhandledRejectionHandler?: (reason: unknown) => void;
	uncaughtExceptionHandler?: (error: Error) => void;
}

const globalWithTauGuards = globalThis as typeof globalThis & {
	__tauProcessGuards?: ProcessGuardsState;
};

const guardsState: ProcessGuardsState = globalWithTauGuards.__tauProcessGuards ?? {
	installed: false,
	pi: undefined,
	lastReportedAt: 0,
};

globalWithTauGuards.__tauProcessGuards = guardsState;

function toErrorString(reason: unknown): string {
	if (reason instanceof Error) {
		return reason.stack ?? reason.message;
	}
	if (typeof reason === "string") return reason;
	try {
		return JSON.stringify(reason);
	} catch {
		return String(reason);
	}
}

function toShortErrorString(reason: unknown, max = 600): string {
	const full = reason instanceof Error ? (reason.message || String(reason)) : toErrorString(reason);
	if (full.length <= max) return full;
	return full.slice(0, Math.max(0, max - 3)) + "...";
}

function extractAuthHint(message: string): string | undefined {
	// Examples:
	// - Authentication failed for "google-gemini-cli". ... Run '/login google-gemini-cli' ...
	// - No API key found for "anthropic". ...
	const authFailed = message.match(/Authentication failed for\s+"([^"]+)"/);
	if (authFailed?.[1]) return authFailed[1];
	const noKey = message.match(/No API key found for\s+"([^"]+)"/);
	if (noKey?.[1]) return noKey[1];
	return undefined;
}

function shouldThrottle(now: number): boolean {
	// Prevent a flood of notifications if multiple workers crash at once.
	// 1s is enough to keep the UI readable.
	if (now - guardsState.lastReportedAt < 1000) return true;
	guardsState.lastReportedAt = now;
	return false;
}

async function handleFatalLikeError(pi: ExtensionAPI, kind: string, reason: unknown): Promise<void> {
	const now = Date.now();
	if (shouldThrottle(now)) return;

	const msg = toErrorString(reason);
	const shortMsg = toShortErrorString(reason);
	const provider = extractAuthHint(msg);

	const header = provider
		? `Agent runtime error (${kind}): provider auth missing/expired for "${provider}".`
		: `Agent runtime error (${kind}).`;

	const hint = provider
		? `Run '/login ${provider}' to re-authenticate, then retry the command.`
		: "Check network connectivity and provider credentials, then retry.";

	// Keep the interactive session alive instead of crashing to the terminal.
	try {
		pi.sendMessage({
			customType: "tau.runtime_error",
			// Keep content short so we don't pollute the LLM context with large stack traces.
			content: `${header}\n${hint}\n\n${shortMsg}`,
			display: true,
			details: {
				kind,
				provider,
				full: msg,
			},
		});
	} catch {
		// ignore
	}

	// The underlying agent loop may have crashed without emitting agent_end events.
	// Close all running agents so /agent wait doesn't hang forever.
	try {
		await closeAllAgents();
	} catch {
		// ignore
	}
}

export function installAgentProcessGuards(pi: ExtensionAPI): void {
	// Always refresh the active PI API reference (extension can be reloaded).
	guardsState.pi = pi;

	if (guardsState.installed) return;
	guardsState.installed = true;

	guardsState.unhandledRejectionHandler = (reason) => {
		const activePi = guardsState.pi;
		if (!activePi) return;
		void handleFatalLikeError(activePi, "unhandledRejection", reason);
	};

	guardsState.uncaughtExceptionHandler = (error) => {
		const activePi = guardsState.pi;
		if (!activePi) return;
		void handleFatalLikeError(activePi, "uncaughtException", error);
	};

	process.on("unhandledRejection", guardsState.unhandledRejectionHandler);
	process.on("uncaughtException", guardsState.uncaughtExceptionHandler);
}
