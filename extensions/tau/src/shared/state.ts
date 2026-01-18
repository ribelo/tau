import type { TauConfig } from "./config.js";

export const TAU_PERSISTED_STATE_TYPE = "tau:state";

export type TauPersistedState = {
	terminalPrompt?: { enabled?: boolean };
	workedFor?: { enabled?: boolean; toolsEnabled?: boolean };
	status?: { fetchedAt: number; values: Record<string, { percentLeft: number }> };
	sandbox?: Record<string, unknown>;
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

function deepMerge(base: any, patch: any): any {
	if (patch === undefined) return base;
	if (base === undefined) return patch;
	if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
	const out: any = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		out[k] = deepMerge((base as any)[k], v);
	}
	return out;
}

export function loadPersistedState(ctx: { sessionManager: { getEntries: () => any[] } }): TauPersistedState {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === TAU_PERSISTED_STATE_TYPE)
		.pop() as { data?: TauPersistedState } | undefined;
	return (last?.data && typeof last.data === "object" ? last.data : {}) as TauPersistedState;
}

export function updatePersistedState(
	pi: { appendEntry: (customType: string, data: any) => void },
	state: TauState,
	patch: Partial<TauPersistedState>,
): void {
	state.persisted = deepMerge(state.persisted, patch) as TauPersistedState;
	pi.appendEntry(TAU_PERSISTED_STATE_TYPE, state.persisted);
}
