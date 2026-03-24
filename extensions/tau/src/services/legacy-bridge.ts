import type { TauPersistedState, TauState } from "../shared/state.js";

interface LegacyPersistedBridge {
	readonly getSnapshotSync: () => TauPersistedState;
	readonly setSnapshotSync: (next: TauPersistedState) => void;
}

export const makeLegacyStateBridge = (persistedBridge: LegacyPersistedBridge): TauState => {
	const sharedRuntimeState: Record<string, unknown> = {};
	const state: TauState = {
		config: {},
		get persisted() {
			return persistedBridge.getSnapshotSync();
		},
		set persisted(val: TauPersistedState) {
			persistedBridge.setSnapshotSync(val);
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
