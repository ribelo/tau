import { Effect, SubscriptionRef } from "effect";
import type { TauPersistedState, TauState } from "../shared/state.js";

/**
 * Shared runtime state for legacy modules.
 * Each service gets the same instance so they can share state buckets
 * (skillMarker, editor, sandbox, etc.) across the legacy boundary.
 */
const sharedRuntimeState: Record<string, Record<string, unknown> | undefined> = {};

export const makeLegacyStateBridge = (
	persistedRef: SubscriptionRef.SubscriptionRef<TauPersistedState>,
): TauState => {
	// We use a cast here because the strict exactOptionalPropertyTypes setting
	// conflicts with getters that return potentially undefined values.
	// This is a bridge layer - the runtime behavior is correct.
	return {
		config: {},
		get persisted() {
			return Effect.runSync(SubscriptionRef.get(persistedRef));
		},
		set persisted(val: TauPersistedState) {
			Effect.runSync(SubscriptionRef.set(persistedRef, val));
		},
		// Runtime state buckets - shared across all legacy modules
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
	} as TauState;
};
