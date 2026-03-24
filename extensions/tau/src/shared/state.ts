import { deepMerge, isRecord } from "./json.js";

export const TAU_PERSISTED_STATE_TYPE = "tau:state";

type PromptModeName = "smart" | "deep" | "rush";

export type TauPersistedState = {
	terminalPrompt?: { enabled?: boolean };
	workedFor?: { enabled?: boolean; toolsEnabled?: boolean };
	status?: { fetchedAt: number; values: Record<string, { percentLeft: number }> };
	promptModes?: {
		activeMode?: PromptModeName;
		modelsByMode?: Partial<Record<PromptModeName, string>>;
	};
	sandbox?: Record<string, unknown>;
	agentAwareness?: {
		instructionsInjected?: boolean;
		lastAgentCount?: number;
	};
};

export function mergePersistedState(
	base: TauPersistedState,
	patch: Partial<TauPersistedState>,
): TauPersistedState {
	return deepMerge(base, patch);
}

function sanitizePromptModes(value: unknown): TauPersistedState["promptModes"] | undefined {
	if (!isRecord(value)) return undefined;
	const out: NonNullable<TauPersistedState["promptModes"]> = {};
	const activeMode = value["activeMode"];
	if (activeMode === "smart" || activeMode === "deep" || activeMode === "rush") {
		out.activeMode = activeMode;
	}

	const modelsByMode = value["modelsByMode"];
	if (isRecord(modelsByMode)) {
		const normalized: Partial<Record<PromptModeName, string>> = {};
		const smart = modelsByMode["smart"];
		const deep = modelsByMode["deep"];
		const rush = modelsByMode["rush"];
		if (typeof smart === "string") normalized.smart = smart;
		if (typeof deep === "string") normalized.deep = deep;
		if (typeof rush === "string") normalized.rush = rush;
		if (Object.keys(normalized).length > 0) out.modelsByMode = normalized;
	}

	if (Object.keys(out).length === 0) return undefined;
	return out;
}

function sanitizeStatusValue(value: unknown): TauPersistedState["status"] | undefined {
	if (!isRecord(value)) return undefined;
	const fetchedAt = value["fetchedAt"];
	const valuesRaw = value["values"];
	if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || !isRecord(valuesRaw)) {
		return undefined;
	}

	const values: Record<string, { percentLeft: number }> = {};
	for (const [key, entry] of Object.entries(valuesRaw)) {
		if (!isRecord(entry)) continue;
		const percentLeft = entry["percentLeft"];
		if (typeof percentLeft !== "number" || !Number.isFinite(percentLeft)) continue;
		values[key] = { percentLeft };
	}

	return { fetchedAt, values };
}

function sanitizeTerminalPrompt(value: unknown): TauPersistedState["terminalPrompt"] | undefined {
	if (!isRecord(value)) return undefined;
	const enabled = value["enabled"];
	if (typeof enabled !== "boolean") return undefined;
	return { enabled };
}

function sanitizeWorkedFor(value: unknown): TauPersistedState["workedFor"] | undefined {
	if (!isRecord(value)) return undefined;
	const out: NonNullable<TauPersistedState["workedFor"]> = {};
	const enabled = value["enabled"];
	const toolsEnabled = value["toolsEnabled"];
	if (typeof enabled === "boolean") out.enabled = enabled;
	if (typeof toolsEnabled === "boolean") out.toolsEnabled = toolsEnabled;
	if (Object.keys(out).length === 0) return undefined;
	return out;
}

function sanitizeAgentAwareness(value: unknown): TauPersistedState["agentAwareness"] | undefined {
	if (!isRecord(value)) return undefined;
	const out: NonNullable<TauPersistedState["agentAwareness"]> = {};
	const instructionsInjected = value["instructionsInjected"];
	const lastAgentCount = value["lastAgentCount"];
	if (typeof instructionsInjected === "boolean") out.instructionsInjected = instructionsInjected;
	if (typeof lastAgentCount === "number" && Number.isFinite(lastAgentCount)) {
		out.lastAgentCount = lastAgentCount;
	}
	if (Object.keys(out).length === 0) return undefined;
	return out;
}

function sanitizePersistedState(value: unknown): TauPersistedState {
	if (!isRecord(value)) return {};
	const out: TauPersistedState = {};

	const terminalPrompt = sanitizeTerminalPrompt(value["terminalPrompt"]);
	if (terminalPrompt) out.terminalPrompt = terminalPrompt;

	const workedFor = sanitizeWorkedFor(value["workedFor"]);
	if (workedFor) out.workedFor = workedFor;

	const status = sanitizeStatusValue(value["status"]);
	if (status) out.status = status;

	const promptModes = sanitizePromptModes(value["promptModes"]);
	if (promptModes) out.promptModes = promptModes;

	const sandbox = value["sandbox"];
	if (isRecord(sandbox)) out.sandbox = sandbox;

	const agentAwareness = sanitizeAgentAwareness(value["agentAwareness"]);
	if (agentAwareness) out.agentAwareness = agentAwareness;

	return out;
}

export function loadPersistedState(ctx: {
	sessionManager: { getEntries: () => unknown[] };
}): TauPersistedState {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter(
			(e): e is { type: "custom"; customType: string; data: unknown } =>
				isRecord(e) &&
				e["type"] === "custom" &&
				e["customType"] === TAU_PERSISTED_STATE_TYPE,
		)
		.pop();

	return sanitizePersistedState(last?.data);
}
