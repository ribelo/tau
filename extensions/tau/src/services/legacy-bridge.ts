import { Effect, SubscriptionRef } from "effect";
import type { TauPersistedState } from "../shared/state.js";

export const makeLegacyStateBridge = (state: SubscriptionRef.SubscriptionRef<TauPersistedState>) => ({
	get persisted() {
		return Effect.runSync(SubscriptionRef.get(state));
	},
	set persisted(val: TauPersistedState) {
		Effect.runSync(SubscriptionRef.set(state, val));
	},
});
