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
	// Ensure user config exists (first-run defaults). Safe: only fills missing keys.
	ensureUserDefaults();

	pi.on("session_start", async (_event, ctx) => {
		// Placeholder: just compute effective config so we know the merge works.
		// Commands + tool overrides will be added later.
		const sessionOverride = loadSessionOverride(ctx);
		const effective = computeEffectiveConfig({ workspaceRoot: ctx.cwd, sessionOverride });
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Sandbox defaults loaded: fs=${effective.filesystemMode}, net=${effective.networkMode}, approval=${effective.approvalPolicy}`,
				"info",
			);
		}
	});
}

export * from "./config.js";
