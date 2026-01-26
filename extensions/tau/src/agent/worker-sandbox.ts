import type { SandboxConfig } from "../sandbox/config.js";
import type { TauPersistedState } from "../shared/state.js";
import { mergePersistedState } from "../shared/state.js";

export function withWorkerSandboxOverride(
	base: TauPersistedState,
	override: Required<SandboxConfig>,
): TauPersistedState {
	return mergePersistedState(base, { sandbox: { override } as unknown as Record<string, unknown> });
}

