import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import initEditor from "./editor/index.js";
import { TAU_PERSISTED_STATE_TYPE, createState, loadPersistedState, updatePersistedState, type TauPersistedState } from "./shared/index.js";
import initCommit from "./commit/index.js";
import initStatus from "./status/index.js";
import initTerminalPrompt from "./terminal-prompt/index.js";
import initWorkedFor from "./worked-for/index.js";
import initSkillMarker from "./skill-marker/index.js";
import initExa from "./exa/index.js";
import initBeads from "./beads/index.js";
import initSandbox from "./sandbox/index.js";
import initTask from "./task/index.js";

import initFooter from "./footer/index.js";

export default function tau(pi: ExtensionAPI) {
	const state = createState();

	pi.on("session_start", async (_event, ctx) => {
		state.persisted = loadPersistedState(ctx);

		// Best-effort migration from legacy custom state entries into the unified tau:state.
		const entries = ctx.sessionManager.getEntries();
		const hasUnified = entries.some(
			(e: { type: string; customType?: string }) => e.type === "custom" && e.customType === TAU_PERSISTED_STATE_TYPE,
		);
		if (hasUnified) return;

		const legacyTau = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "tau-state")
			.pop() as { data?: { terminalPrompt?: boolean } } | undefined;

		const legacyWorkedFor = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "tau:worked-for-state")
			.pop() as { data?: { enabled?: boolean; toolsEnabled?: boolean } } | undefined;

		const legacyStatus = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "tau:status-state")
			.pop() as { data?: { fetchedAt: number; values: Record<string, { percentLeft: number }> } } | undefined;

		const legacySandbox = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "sandbox_state")
			.pop() as { data?: Record<string, unknown> } | undefined;

		const patch: Partial<TauPersistedState> = {};
		if (typeof legacyTau?.data?.terminalPrompt === "boolean") {
			patch.terminalPrompt = { enabled: legacyTau.data.terminalPrompt };
		}
		if (legacyWorkedFor?.data && (legacyWorkedFor.data.enabled !== undefined || legacyWorkedFor.data.toolsEnabled !== undefined)) {
			patch.workedFor = { ...legacyWorkedFor.data };
		}
		if (legacyStatus?.data && typeof legacyStatus.data.fetchedAt === "number" && legacyStatus.data.values) {
			patch.status = legacyStatus.data;
		}
		if (legacySandbox?.data) {
			patch.sandbox = legacySandbox.data;
		}

		if (Object.keys(patch).length > 0) {
			updatePersistedState(pi, state, patch);
		}
	});

	// TODO(tau-i3c): wire TauEditor on session_start
	// TODO(tau-i3c): migrate all features into vertical slices (initX(pi, state))

	// Temporary composition root: will be migrated to vertical-slice init functions.
	initEditor(pi, state);
	initSkillMarker(pi, state);
	initTerminalPrompt(pi, state);
	initSandbox(pi, state);
	initTask(pi, state);
	initWorkedFor(pi, state);
	initStatus(pi, state);
	initCommit(pi, state);
	initExa(pi, state);
	initBeads(pi, state);
	initFooter(pi, state);
}
