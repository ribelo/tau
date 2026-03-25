import { ServiceMap, Effect, Layer } from "effect";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { PiAPI } from "../effect/pi.js";
import {
	isPromptModeName,
	resolvePromptModePresets,
	type PromptModeName,
} from "../prompt/modes.js";
import type { TauPersistedState } from "../shared/state.js";
import { loadPersistedState } from "../shared/state.js";
import { Persistence } from "./persistence.js";
import { parseProviderModel } from "../shared/model-id.js";

export interface PromptModes {
	readonly setup: Effect.Effect<void>;
}

export const PromptModes = ServiceMap.Service<PromptModes>("PromptModes");

type PromptModePersistence = {
	readonly getSnapshot: () => TauPersistedState;
	readonly hydrate: (patch: Partial<TauPersistedState>) => void;
	readonly update: (patch: Partial<TauPersistedState>) => void;
};

type WithModelSelectSuppressed = <A>(run: () => Promise<A>) => Promise<A>;

function resolvePersistedMode(
	state: { promptModes?: { activeMode?: PromptModeName | undefined } | undefined } | undefined,
): PromptModeName {
	const active = state?.promptModes?.activeMode;
	return active ?? "smart";
}

function resolveModeModelCandidates(
	state: TauPersistedState,
	mode: PromptModeName,
	presetModel: string,
): readonly string[] {
	const assigned = state.promptModes?.modelsByMode?.[mode];
	if (!assigned || assigned === presetModel) return [presetModel];
	return [assigned, presetModel];
}

function persistModeState(
	persistence: PromptModePersistence,
	mode: PromptModeName,
	selectedModel: string,
): void {
	const current = persistence.getSnapshot();
	const modelsByMode: Partial<Record<PromptModeName, string>> = {
		...current.promptModes?.modelsByMode,
		[mode]: selectedModel,
	};

	persistence.update({
		promptModes: {
			activeMode: mode,
			modelsByMode,
		},
	});
}

async function applyModeSelection(
	pi: ExtensionAPI,
	persistence: PromptModePersistence,
	mode: PromptModeName,
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry" | "ui">,
	options: {
		readonly notifyOnSuccess: boolean;
		readonly withModelSelectSuppressed?: WithModelSelectSuppressed;
	},
): Promise<void> {
	const state = persistence.getSnapshot();
	const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
	const preset = presets[mode];
	const candidates = resolveModeModelCandidates(state, mode, preset.model);

	let selectedModelId: string | undefined = undefined;

	for (const candidate of candidates) {
		const parsed = parseProviderModel(candidate);
		if (!parsed) {
			ctx.ui.notify(`Mode ${mode}: invalid model id: ${candidate}`, "error");
			continue;
		}

		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) {
			if (candidate !== preset.model) {
				ctx.ui.notify(
					`Mode ${mode}: assigned model not found, using preset (${preset.model})`,
					"warning",
				);
			} else {
				ctx.ui.notify(`Mode ${mode}: model not found: ${candidate}`, "error");
			}
			continue;
		}

		const ok = options.withModelSelectSuppressed
			? await options.withModelSelectSuppressed(() => pi.setModel(model))
			: await pi.setModel(model);
		if (!ok) {
			if (candidate !== preset.model) {
				ctx.ui.notify(
					`Mode ${mode}: no auth for assigned model, using preset (${preset.model})`,
					"warning",
				);
				continue;
			}
			ctx.ui.notify(`Mode ${mode}: no auth available for ${candidate}`, "error");
			continue;
		}

		selectedModelId = `${parsed.provider}/${parsed.modelId}`;
		break;
	}

	if (!selectedModelId) return;

	pi.setThinkingLevel(preset.thinking);
	persistModeState(persistence, mode, selectedModelId);
	pi.events.emit("tau:mode:changed", { mode });
	if (options.notifyOnSuccess) {
		ctx.ui.notify(`Mode: ${mode}`, "info");
	}
}

async function applyMode(
	pi: ExtensionAPI,
	persistence: PromptModePersistence,
	mode: PromptModeName,
	ctx: ExtensionCommandContext,
	options?: {
		readonly withModelSelectSuppressed?: WithModelSelectSuppressed;
	},
): Promise<void> {
	await applyModeSelection(pi, persistence, mode, ctx, {
		notifyOnSuccess: true,
		...(options?.withModelSelectSuppressed
			? { withModelSelectSuppressed: options.withModelSelectSuppressed }
			: {}),
	});
}

async function syncModeForSessionContext(
	pi: ExtensionAPI,
	persistence: PromptModePersistence,
	ctx: ExtensionContext,
	options?: {
		readonly withModelSelectSuppressed?: WithModelSelectSuppressed;
	},
): Promise<void> {
	if (!ctx.hasUI) return;

	const sessionState = loadPersistedState(ctx);
	if (sessionState.promptModes) {
		persistence.hydrate({ promptModes: sessionState.promptModes });
	}

	const mode = resolvePersistedMode(persistence.getSnapshot());
	await applyModeSelection(pi, persistence, mode, ctx, {
		notifyOnSuccess: false,
		...(options?.withModelSelectSuppressed
			? { withModelSelectSuppressed: options.withModelSelectSuppressed }
			: {}),
	});
}

export const PromptModesLive = Layer.effect(
	PromptModes,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return PromptModes.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					let baseSystemPrompt: string | undefined = undefined;
					let suppressModelSelectEvents = 0;
					const withModelSelectSuppressed: WithModelSelectSuppressed = async (run) => {
						suppressModelSelectEvents += 1;
						try {
							return await run();
						} finally {
							suppressModelSelectEvents -= 1;
						}
					};

					pi.registerCommand("mode", {
						description: "Prompt mode: /mode [smart|deep|rush|list]",
						handler: async (args, ctx) => {
							const trimmed = (args || "").trim();

							if (!trimmed) {
								if (!ctx.hasUI) {
									return;
								}

								const choice = await ctx.ui.select("Mode", [
									"smart",
									"deep",
									"rush",
								]);
								if (!choice) return;
								if (!isPromptModeName(choice)) {
									ctx.ui.notify(`Invalid mode: ${choice}`, "error");
									return;
								}

								await applyMode(pi, persistence, choice, ctx, {
									withModelSelectSuppressed,
								});
								return;
							}

							if (trimmed === "list") {
								const state = persistence.getSnapshot();
								const active = resolvePersistedMode(state);
								const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
								const lines = [
									"Modes:",
									`- smart${active === "smart" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.smart ?? presets.smart.model} (${presets.smart.thinking})`,
									`- deep${active === "deep" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.deep ?? presets.deep.model} (${presets.deep.thinking})`,
									`- rush${active === "rush" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.rush ?? presets.rush.model} (${presets.rush.thinking})`,
								];
								ctx.ui.notify(lines.join("\n"), "info");
								return;
							}

							const lower = trimmed.toLowerCase();
							if (!isPromptModeName(lower)) {
								ctx.ui.notify("Usage: /mode smart|deep|rush|list", "info");
								return;
							}

							await applyMode(pi, persistence, lower, ctx, {
								withModelSelectSuppressed,
							});
						},
					});

					pi.on("session_start", async (_event, ctx) => {
						await syncModeForSessionContext(pi, persistence, ctx, {
							withModelSelectSuppressed,
						});
					});

					pi.on("session_switch", async (_event, ctx) => {
						await syncModeForSessionContext(pi, persistence, ctx, {
							withModelSelectSuppressed,
						});
					});

					pi.on("model_select", async (event, ctx) => {
						// /mode switches mode+model atomically and persists after selection.
						// Ignore those internal "set" events so they do not overwrite the previous mode mapping.
						if (event.source === "set" && suppressModelSelectEvents > 0) {
							return;
						}
						const persistedSessionState = loadPersistedState(ctx);
						const inMemoryState = persistence.getSnapshot();
						const mode =
							persistedSessionState.promptModes?.activeMode ??
							resolvePersistedMode(inMemoryState);
						const selectedModel = `${event.model.provider}/${event.model.id}`;
						persistModeState(persistence, mode, selectedModel);
					});

					pi.on("before_agent_start", async (event, ctx) => {
						// pi may call before_agent_start multiple times (e.g. model switches). Always rebuild
						// from the original base prompt so the mode prompt is injected exactly once.
						if (baseSystemPrompt === undefined) baseSystemPrompt = event.systemPrompt;

						const mode = resolvePersistedMode(persistence.getSnapshot());
						const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
						const preset = presets[mode];
						return { systemPrompt: `${baseSystemPrompt}\n\n${preset.systemPrompt}` };
					});
				});
			}),
		});
	}),
);
