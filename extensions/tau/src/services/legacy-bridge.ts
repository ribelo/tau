import type { TauPersistedState, TauState } from "../shared/state.js";

/**
 * Shared runtime state for legacy modules.
 * Each service gets the same instance so they can share state buckets
 * (skillMarker, editor, sandbox, etc.) across the legacy boundary.
 */
const sharedRuntimeState: Record<string, unknown> = {};

export interface LegacyPersistedBridge {
	readonly getSnapshot: () => TauPersistedState;
	readonly setSnapshot: (next: TauPersistedState) => void;
}

export const makeLegacyStateBridge = (persistedBridge: LegacyPersistedBridge): TauState => {
	const state: TauState = {
		config: {},
		get persisted() {
			return persistedBridge.getSnapshot();
		},
		set persisted(val: TauPersistedState) {
			persistedBridge.setSnapshot(val);
		},
		get skillMarker() {
			return sharedRuntimeState["skillMarker"];
		},
		set skillMarker(val) {
			sharedRuntimeState["skillMarker"] = val;
		},
		get editor() {
			return sharedRuntimeState["editor"];
		},
		set editor(val) {
			sharedRuntimeState["editor"] = val;
		},
		get sandbox() {
			return sharedRuntimeState["sandbox"];
		},
		set sandbox(val) {
			sharedRuntimeState["sandbox"] = val;
		},
		get beads() {
			return sharedRuntimeState["beads"];
		},
		set beads(val) {
			sharedRuntimeState["beads"] = val;
		},
		get exa() {
			return sharedRuntimeState["exa"];
		},
		set exa(val) {
			sharedRuntimeState["exa"] = val;
		},
		get task() {
			return sharedRuntimeState["task"];
		},
		set task(val) {
			sharedRuntimeState["task"] = val;
		},
		get commit() {
			return sharedRuntimeState["commit"];
		},
		set commit(val) {
			sharedRuntimeState["commit"] = val;
		},
	};

	return state;
};
