import type { TauConfig } from "./config.js";
import { deepMerge, isRecord } from "./json.js";

export const TAU_PERSISTED_STATE_TYPE = "tau:state";

export type TauPersistedState = {
	terminalPrompt?: { enabled?: boolean };
	workedFor?: { enabled?: boolean; toolsEnabled?: boolean };
	status?: { fetchedAt: number; values: Record<string, { percentLeft: number }> };
	promptModes?: { activeMode?: "smart" | "deep" | "rush" };
	sandbox?: Record<string, unknown>;
	agentAwareness?: {
		instructionsInjected?: boolean;
		lastAgentCount?: number;
	};
};

export type TauState = {
	config: TauConfig;
	persisted: TauPersistedState;

	// Placeholder state buckets; migrated features should store their state here.
	editor?: Record<string, unknown>;
	beads?: Record<string, unknown>;
	exa?: Record<string, unknown>;
	sandbox?: Record<string, unknown>;
	task?: Record<string, unknown>;
	skillMarker?: Record<string, unknown>;
	commit?: Record<string, unknown>;
};

export function createState(config: TauConfig = {}): TauState {
	return {
		config,
		persisted: {},
	};
}

export function mergePersistedState(
	base: TauPersistedState,
	patch: Partial<TauPersistedState>,
): TauPersistedState {
	return deepMerge(base, patch);
}

export function loadPersistedState(ctx: { sessionManager: { getEntries: () => unknown[] } }): TauPersistedState {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter(
			(e): e is { type: "custom"; customType: string; data: unknown } =>
				isRecord(e) && e["type"] === "custom" && e["customType"] === TAU_PERSISTED_STATE_TYPE,
		)
		.pop();

	return isRecord(last?.data) ? (last.data as unknown as TauPersistedState) : {};
}

export function updatePersistedState(
	pi: { appendEntry: (customType: string, data: unknown) => void },
	state: TauState,
	patch: Partial<TauPersistedState>,
): void {
	state.persisted = mergePersistedState(state.persisted, patch);
	pi.appendEntry(TAU_PERSISTED_STATE_TYPE, state.persisted);
}
