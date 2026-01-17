import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { SandboxConfig } from "./config.js";
import { computeEffectiveConfig, ensureUserDefaults } from "./config.js";

const STATE_TYPE = "sandbox_state";

type SessionState = {
	override?: SandboxConfig;
};

function loadSessionOverride(ctx: any): SandboxConfig | undefined {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((e: any) => e.type === "custom" && e.customType === STATE_TYPE)
		.pop() as { data?: SessionState } | undefined;
	return last?.data?.override;
}

export default function sandbox(pi: ExtensionAPI) {
	// First-run: ensure sandbox defaults are written into ~/.pi/agent/settings.json (only fills missing keys).
	ensureUserDefaults();

	pi.on("session_start", async (_event, ctx) => {
		// Validate config load + session override merge.
		const sessionOverride = loadSessionOverride(ctx);
		computeEffectiveConfig({ workspaceRoot: ctx.cwd, sessionOverride });
	});
}

export * from "./config.js";
