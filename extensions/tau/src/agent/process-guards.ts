import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { closeAllAgents } from "./runtime.js";

let installed = false;
let lastReportedAt = 0;

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
	if (now - lastReportedAt < 1000) return true;
	lastReportedAt = now;
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
	if (installed) return;
	installed = true;

	process.on("unhandledRejection", (reason) => {
		void handleFatalLikeError(pi, "unhandledRejection", reason);
	});

	process.on("uncaughtException", (error) => {
		void handleFatalLikeError(pi, "uncaughtException", error);
	});
}
