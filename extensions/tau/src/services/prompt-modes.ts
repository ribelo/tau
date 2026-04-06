import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Effect, Layer, ServiceMap } from "effect";

import { isPromptModeThinkingLevel } from "../agent/model-spec.js";
import { PiAPI } from "../effect/pi.js";
import {
	type PromptModeProfile,
	readModelId,
} from "../prompt/profile.js";
import {
	isPromptModeName,
	isPromptModePresetName,
	resolvePromptModePresets,
	type PromptModeName,
	type PromptModePresetName,
} from "../prompt/modes.js";
import { parseProviderModel } from "../shared/model-id.js";
import type { TauPersistedState } from "../shared/state.js";
import { loadPersistedState } from "../shared/state.js";
import { Persistence } from "./persistence.js";

export type PromptModeApplyResult =
	| {
			readonly applied: true;
			readonly profile: PromptModeProfile;
	  }
	| {
			readonly applied: false;
			readonly reason: string;
	  };

export interface PromptModes {
	readonly setup: Effect.Effect<void>;
	readonly captureCurrentProfile: (
		ctx: Pick<ExtensionContext, "model">,
	) => Effect.Effect<PromptModeProfile | null>;
	readonly applyProfile: (
		profile: PromptModeProfile,
		ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
		options?: {
			readonly notifyOnSuccess?: boolean;
			readonly persist?: boolean;
		},
	) => Effect.Effect<PromptModeApplyResult>;
}

export const PromptModes = ServiceMap.Service<PromptModes>("PromptModes");

type PromptModePersistence = {
	readonly getSnapshot: () => TauPersistedState;
	readonly hydrate: (patch: Partial<TauPersistedState>) => void;
	readonly update: (patch: Partial<TauPersistedState>) => void;
};

type WithModelSelectSuppressed = <A>(run: () => Promise<A>) => Promise<A>;

type PromptRuntimeContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "ui">;

const MODE_PROMPT_SENTINEL = "<!-- tau:mode-prompt -->";

function stripInjectedModePrompt(systemPrompt: string): string {
	const sentinelIndex = systemPrompt.indexOf(MODE_PROMPT_SENTINEL);
	return sentinelIndex === -1 ? systemPrompt : systemPrompt.slice(0, sentinelIndex).trimEnd();
}

function resolvePersistedMode(
	state: { promptModes?: { activeMode?: PromptModeName | undefined } | undefined } | undefined,
): PromptModeName {
	const active = state?.promptModes?.activeMode;
	return active ?? "default";
}

function resolveModeModelCandidates(
	state: TauPersistedState,
	mode: PromptModePresetName,
	presetModel: string,
): readonly string[] {
	const assigned = state.promptModes?.modelsByMode?.[mode];
	if (!assigned || assigned === presetModel) return [presetModel];
	return [assigned, presetModel];
}

function persistModeState(
	persistence: PromptModePersistence,
	mode: PromptModeName,
	selectedModel?: string,
	options?: { readonly persist?: boolean },
): void {
	const write = options?.persist === false ? persistence.hydrate : persistence.update;

	if (!isPromptModePresetName(mode) || selectedModel === undefined) {
		write({
			promptModes: {
				activeMode: mode,
			},
		});
		return;
	}

	const current = persistence.getSnapshot();
	const modelsByMode: Partial<Record<PromptModeName, string>> = {
		...current.promptModes?.modelsByMode,
		[mode]: selectedModel,
	};

	write({
		promptModes: {
			activeMode: mode,
			modelsByMode,
		},
	});
}

function currentThinkingLevel(pi: ExtensionAPI): ThinkingLevel | undefined {
	const current = pi.getThinkingLevel();
	if (!isPromptModeThinkingLevel(current)) {
		return undefined;
	}
	return current;
}

function makeApplyFailure(reason: string): PromptModeApplyResult {
	return { applied: false, reason };
}

export const PromptModesLive = Layer.effect(
	PromptModes,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		let suppressModelSelectEvents = 0;
		let sessionDefaultProfile: PromptModeProfile | undefined = undefined;

		const withModelSelectSuppressed: WithModelSelectSuppressed = async (run) => {
			suppressModelSelectEvents += 1;
			try {
				return await run();
			} finally {
				suppressModelSelectEvents -= 1;
			}
		};

		const captureRuntimeProfile = (
			ctx: Pick<ExtensionContext, "model">,
			mode: PromptModeName,
		): PromptModeProfile | null => {
			const model = readModelId(ctx.model);
			if (model === undefined) {
				return null;
			}
			const thinking = currentThinkingLevel(pi);
			if (thinking === undefined) {
				return null;
			}
			return {
				mode,
				model,
				thinking,
			};
		};

		const captureCurrentProfile: PromptModes["captureCurrentProfile"] = (ctx) =>
			Effect.sync(() => {
				const mode = resolvePersistedMode(persistence.getSnapshot());
				const profile = captureRuntimeProfile(ctx, mode);
				if (profile === null) {
					return null;
				}

				if (profile.mode === "default") {
					sessionDefaultProfile = profile;
					persistModeState(persistence, "default");
				} else {
					persistModeState(persistence, profile.mode, profile.model);
				}

				return profile;
			});

		const emitModeChanged = (mode: PromptModeName): void => {
			pi.events.emit("tau:mode:changed", { mode });
		};

		const notifyApplyFailure = (
			ctx: Pick<ExtensionContext, "ui">,
			reason: string,
		): PromptModeApplyResult => {
			ctx.ui.notify(reason, "error");
			return makeApplyFailure(reason);
		};

		const applyResolvedProfile = async (
			profile: PromptModeProfile,
			ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
			options?: {
				readonly notifyOnSuccess?: boolean;
				readonly persist?: boolean;
			},
		): Promise<PromptModeApplyResult> => {
			const currentMode = resolvePersistedMode(persistence.getSnapshot());
			if (currentMode === "default" && profile.mode !== "default") {
				const baseline = captureRuntimeProfile(ctx, "default");
				if (baseline !== null) {
					sessionDefaultProfile = baseline;
				}
			}

			const currentModel = readModelId(ctx.model);
			if (currentModel !== profile.model) {
				const parsed = parseProviderModel(profile.model);
				if (!parsed) {
					return notifyApplyFailure(ctx, `Mode ${profile.mode}: invalid model id: ${profile.model}`);
				}

				const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
				if (!model) {
					return notifyApplyFailure(
						ctx,
						`Mode ${profile.mode}: model not found: ${profile.model}`,
					);
				}

				const ok = await withModelSelectSuppressed(() => pi.setModel(model));
				if (!ok) {
					return notifyApplyFailure(
						ctx,
						`Mode ${profile.mode}: no auth available for ${profile.model}`,
					);
				}
			}

			if (currentThinkingLevel(pi) !== profile.thinking) {
				pi.setThinkingLevel(profile.thinking);
			}

			if (profile.mode === "default") {
				sessionDefaultProfile = profile;
				persistModeState(
					persistence,
					"default",
					undefined,
					options?.persist === undefined ? undefined : { persist: options.persist },
				);
			} else {
				persistModeState(
					persistence,
					profile.mode,
					profile.model,
					options?.persist === undefined ? undefined : { persist: options.persist },
				);
			}

			emitModeChanged(profile.mode);
			if (options?.notifyOnSuccess) {
				ctx.ui.notify(`Mode: ${profile.mode}`, "info");
			}

			return {
				applied: true,
				profile,
			};
		};

		const applyProfile: PromptModes["applyProfile"] = (profile, ctx, options) =>
			Effect.promise(() => applyResolvedProfile(profile, ctx, options));

		const resolveModeProfile = async (
			mode: PromptModeName,
			ctx: PromptRuntimeContext,
		): Promise<PromptModeApplyResult> => {
			if (!isPromptModePresetName(mode)) {
				const profile =
					sessionDefaultProfile ?? captureRuntimeProfile(ctx, "default");
				if (profile === null || profile === undefined) {
					return notifyApplyFailure(
						ctx,
						"Mode default: no baseline model/thinking profile is available for this session",
					);
				}
				return applyResolvedProfile({ ...profile, mode: "default" }, ctx, {
					notifyOnSuccess: true,
				});
			}

			const state = persistence.getSnapshot();
			if (resolvePersistedMode(state) === "default") {
				const baseline = captureRuntimeProfile(ctx, "default");
				if (baseline !== null) {
					sessionDefaultProfile = baseline;
				}
			}
			const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
			const preset = presets[mode];
			const candidates = resolveModeModelCandidates(state, mode, preset.model);

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
						continue;
					}
					return notifyApplyFailure(ctx, `Mode ${mode}: model not found: ${candidate}`);
				}

				const ok = await withModelSelectSuppressed(() => pi.setModel(model));
				if (!ok) {
					if (candidate !== preset.model) {
						ctx.ui.notify(
							`Mode ${mode}: no auth for assigned model, using preset (${preset.model})`,
							"warning",
						);
						continue;
					}
					return notifyApplyFailure(ctx, `Mode ${mode}: no auth available for ${candidate}`);
				}

				const profile: PromptModeProfile = {
					mode,
					model: `${parsed.provider}/${parsed.modelId}`,
					thinking: preset.thinking,
				};

				if (currentThinkingLevel(pi) !== profile.thinking) {
					pi.setThinkingLevel(profile.thinking);
				}

				persistModeState(persistence, profile.mode, profile.model);
				emitModeChanged(profile.mode);
				ctx.ui.notify(`Mode: ${profile.mode}`, "info");
				return { applied: true, profile };
			}

			return makeApplyFailure(`Mode ${mode}: could not resolve an authenticated model`);
		};

		const syncModeForSessionContext = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;

			const sessionState = loadPersistedState(ctx);
			if (sessionState.promptModes?.modelsByMode) {
				persistence.hydrate({
					promptModes: {
						modelsByMode: sessionState.promptModes.modelsByMode,
					},
				});
			}

			const baseline = captureRuntimeProfile(ctx, "default");
			if (baseline !== null) {
				sessionDefaultProfile = baseline;
				const _result = await applyResolvedProfile(baseline, ctx, {
					notifyOnSuccess: false,
					persist: false,
				});
				return;
			}

			persistModeState(persistence, "default", undefined, { persist: false });
			emitModeChanged("default");
		};

		return PromptModes.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					pi.registerCommand("mode", {
						description: "Prompt mode: /mode [default|smart|deep|rush|plan|list]",
						handler: async (args, ctx) => {
							const trimmed = (args || "").trim();

							if (!trimmed) {
								if (!ctx.hasUI) {
									return;
								}

								const choice = await ctx.ui.select("Mode", [
									"default",
									"smart",
									"deep",
									"rush",
									"plan",
								]);
								if (!choice) return;
								if (!isPromptModeName(choice)) {
									ctx.ui.notify(`Invalid mode: ${choice}`, "error");
									return;
								}

								await resolveModeProfile(choice, ctx);
								return;
							}

							if (trimmed === "list") {
								const state = persistence.getSnapshot();
								const active = resolvePersistedMode(state);
								const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
								const lines = [
									"Modes:",
									`- default${active === "default" ? " [active]" : ""}`,
									`- smart${active === "smart" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.smart ?? presets.smart.model} (${presets.smart.thinking})`,
									`- deep${active === "deep" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.deep ?? presets.deep.model} (${presets.deep.thinking})`,
									`- rush${active === "rush" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.rush ?? presets.rush.model} (${presets.rush.thinking})`,
									`- plan${active === "plan" ? " [active]" : ""}: ${state.promptModes?.modelsByMode?.plan ?? presets.plan.model} (${presets.plan.thinking})`,
								];
								ctx.ui.notify(lines.join("\n"), "info");
								return;
							}

							const lower = trimmed.toLowerCase();
							if (!isPromptModeName(lower)) {
								ctx.ui.notify("Usage: /mode default|smart|deep|rush|plan|list", "info");
								return;
							}

							await resolveModeProfile(lower, ctx);
						},
					});

					pi.on("session_start", async (_event, ctx) => {
						await syncModeForSessionContext(ctx);
					});

					pi.on("session_switch", async (_event, ctx) => {
						await syncModeForSessionContext(ctx);
					});

					pi.on("model_select", async (event, _ctx) => {
						if (event.source === "set" && suppressModelSelectEvents > 0) {
							return;
						}

						const selectedModel = `${event.model.provider}/${event.model.id}`;
						const mode = resolvePersistedMode(persistence.getSnapshot());
						if (mode === "default") {
							const thinking = currentThinkingLevel(pi);
							if (thinking !== undefined) {
								sessionDefaultProfile = {
									mode: "default",
									model: selectedModel,
									thinking,
								};
							}
							persistModeState(persistence, "default");
							return;
						}

						persistModeState(persistence, mode, selectedModel);
					});

					pi.on("before_agent_start", async (event, ctx) => {
						const baseSystemPrompt = stripInjectedModePrompt(event.systemPrompt);
						const mode = resolvePersistedMode(persistence.getSnapshot());
						if (!isPromptModePresetName(mode)) {
							return { systemPrompt: baseSystemPrompt };
						}

						const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
						const preset = presets[mode];
						return {
							systemPrompt: `${baseSystemPrompt}\n\n${MODE_PROMPT_SENTINEL}\n${preset.systemPrompt}`,
						};
					});
				});
			}),
			captureCurrentProfile,
			applyProfile,
		});
	}),
);
