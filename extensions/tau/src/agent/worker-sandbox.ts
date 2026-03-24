import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import type { TauPersistedState } from "../shared/state.js";
import { mergePersistedState } from "../shared/state.js";

export function withWorkerSandboxOverride(
	base: TauPersistedState,
	override: ResolvedSandboxConfig,
): TauPersistedState {
	const sandboxPatch: Record<string, unknown> = { sessionOverride: override };
	return mergePersistedState(base, {
		sandbox: sandboxPatch,
	});
}
