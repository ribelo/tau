import type { SandboxConfig } from "../sandbox/config.js";
import type { TauPersistedState } from "../shared/state.js";
import { mergePersistedState } from "../shared/state.js";

export function withWorkerSandboxOverride(
	base: TauPersistedState,
	override: Required<SandboxConfig>,
): TauPersistedState {
	const sandboxPatch: Record<string, unknown> = { sessionOverride: override };
	return mergePersistedState(base, {
		sandbox: sandboxPatch,
	});
}

