import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Effect, Layer, MutableRef, Option, ServiceMap } from "effect";

import { isPromptModeThinkingLevel } from "../agent/model-spec.js";
import { PiAPI } from "../effect/pi.js";
import {
	type ExecutionProfile,
	makeExecutionProfile,
} from "../execution/schema.js";
import {
	type PromptModeProfile,
	readModelId,
} from "../prompt/profile.js";
import {
	isPromptModeName,
	isPromptModePresetName,
	resolvePromptModePresets,
	type PromptModeName,
} from "../prompt/modes.js";
import { parseProviderModel } from "../shared/model-id.js";
import { ExecutionState } from "./execution-state.js";
import {
	resolveModeModelCandidates,
	resolveSessionMode,
} from "./execution-resolver.js";

export type PromptModeApplyResult =
	| {
			readonly applied: true;
			readonly profile: PromptModeProfile;
	  }
	| {
			readonly applied: false;
			readonly reason: string;
	  };

export type PromptModeApplyOptions = {
	readonly notifyOnSuccess?: boolean;
	readonly persist?: boolean;
	readonly ephemeral?: boolean;
};

export interface ExecutionRuntime {
	readonly setup: Effect.Effect<void>;
	readonly captureCurrentProfile: (
		ctx: Pick<ExtensionContext, "model">,
	) => Effect.Effect<PromptModeProfile | null>;
	readonly captureCurrentExecutionProfile: (
		ctx: Pick<ExtensionContext, "model">,
	) => Effect.Effect<ExecutionProfile | null>;
	readonly applyProfile: (
		profile: PromptModeProfile,
		ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
		options?: PromptModeApplyOptions,
	) => Effect.Effect<PromptModeApplyResult>;
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
		ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
		options?: PromptModeApplyOptions,
	) => Effect.Effect<PromptModeApplyResult>;
}

export const ExecutionRuntime = ServiceMap.Service<ExecutionRuntime>("ExecutionRuntime");

type WithModelSelectSuppressed = <A>(run: () => Promise<A>) => Promise<A>;

type PromptRuntimeContext = Pick<
	ExtensionContext,
	"cwd" | "model" | "modelRegistry" | "ui"
>;

const MODE_PROMPT_SENTINEL = "<!-- tau:mode-prompt -->";

function stripInjectedModePrompt(systemPrompt: string): string {
	const sentinelIndex = systemPrompt.indexOf(MODE_PROMPT_SENTINEL);
	return sentinelIndex === -1 ? systemPrompt : systemPrompt.slice(0, sentinelIndex).trimEnd();
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

export const ExecutionRuntimeLive = Layer.effect(
	ExecutionRuntime,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const executionState = yield* ExecutionState;

		const suppressModelSelectEventsRef = MutableRef.make(0);

		const resolveActiveMode = (): PromptModeName =>
			resolveSessionMode(executionState.getSnapshot());

		const persistModeState = (
			mode: PromptModeName,
			selectedModel?: string,
			options?: { readonly persist?: boolean; readonly ephemeral?: boolean },
		): void => {
			const apply =
				options?.ephemeral === true
					? executionState.transient
					: options?.persist === false
						? executionState.hydrate
						: executionState.update;
			if (!isPromptModePresetName(mode) || selectedModel === undefined) {
				apply({
					selector: {
						mode,
					},
				});
				return;
			}

			const current = executionState.getSnapshot();
			apply({
				selector: {
					mode,
				},
				modelsByMode: {
					...current.modelsByMode,
					[mode]: selectedModel,
				},
			});
		};

		const withModelSelectSuppressed: WithModelSelectSuppressed = async (run) => {
			MutableRef.set(
				suppressModelSelectEventsRef,
				MutableRef.get(suppressModelSelectEventsRef) + 1,
			);
			try {
				return await run();
			} finally {
				MutableRef.set(
					suppressModelSelectEventsRef,
					Math.max(0, MutableRef.get(suppressModelSelectEventsRef) - 1),
				);
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

		const captureCurrentProfile: ExecutionRuntime["captureCurrentProfile"] = (ctx) =>
			Effect.sync(() => {
				const mode = resolveActiveMode();
				const profile = captureRuntimeProfile(ctx, mode);
				if (profile === null) {
					return null;
				}

				if (profile.mode === "default") {
					executionState.setDefaultProfile(Option.some(profile));
					persistModeState("default");
				} else {
					persistModeState(profile.mode, profile.model);
				}

				return profile;
			});

		const captureCurrentExecutionProfile: ExecutionRuntime["captureCurrentExecutionProfile"] =
			(ctx) =>
				captureCurrentProfile(ctx).pipe(
					Effect.map((promptProfile) => {
						if (promptProfile === null) {
							return null;
						}
						const state = executionState.getSnapshot();
						return makeExecutionProfile({
							selector: {
								mode: promptProfile.mode,
							},
							promptProfile,
							policy: state.policy,
						});
					}),
				);

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
			options?: PromptModeApplyOptions,
		): Promise<PromptModeApplyResult> => {
			const currentMode = resolveActiveMode();
			if (currentMode === "default" && profile.mode !== "default") {
				const baseline = captureRuntimeProfile(ctx, "default");
				if (baseline !== null) {
					executionState.setDefaultProfile(Option.some(baseline));
				}
			}

			const currentModel = readModelId(ctx.model);
			const forceModelSelect = options?.ephemeral === true;
			if (forceModelSelect || currentModel !== profile.model) {
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

			const modeStateOptions =
				options === undefined
					? undefined
					: {
						...(options.persist === undefined ? {} : { persist: options.persist }),
						...(options.ephemeral === undefined
							? {}
							: { ephemeral: options.ephemeral }),
					  };

			if (profile.mode === "default") {
				executionState.setDefaultProfile(Option.some(profile));
				persistModeState("default", undefined, modeStateOptions);
			} else {
				persistModeState(profile.mode, profile.model, modeStateOptions);
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

		const applyProfile: ExecutionRuntime["applyProfile"] = (profile, ctx, options) =>
			Effect.promise(() => applyResolvedProfile(profile, ctx, options));

		const applyExecutionProfile: ExecutionRuntime["applyExecutionProfile"] =
			(profile, ctx, options) =>
				Effect.gen(function* () {
					if (profile.selector.mode !== profile.promptProfile.mode) {
						return makeApplyFailure(
							`Invalid execution profile: selector mode (${profile.selector.mode}) does not match prompt profile mode (${profile.promptProfile.mode})`,
						);
					}

					const applied = yield* applyProfile(profile.promptProfile, ctx, options);
					if (!applied.applied) {
						return applied;
					}

					const apply =
						options?.ephemeral === true
							? executionState.transient
							: options?.persist === false
								? executionState.hydrate
								: executionState.update;
					apply({
						selector: profile.selector,
						policy: profile.policy,
					});

					return applied;
				});

		const resolveModeProfile = async (
			mode: PromptModeName,
			ctx: PromptRuntimeContext,
		): Promise<PromptModeApplyResult> => {
			if (!isPromptModePresetName(mode)) {
				const profile =
					Option.getOrUndefined(executionState.getDefaultProfile()) ??
					captureRuntimeProfile(ctx, "default");
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

			const state = executionState.getSnapshot();
			if (resolveSessionMode(state) === "default") {
				const baseline = captureRuntimeProfile(ctx, "default");
				if (baseline !== null) {
					executionState.setDefaultProfile(Option.some(baseline));
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

				persistModeState(profile.mode, profile.model);
				emitModeChanged(profile.mode);
				ctx.ui.notify(`Mode: ${profile.mode}`, "info");
				return { applied: true, profile };
			}

			return makeApplyFailure(`Mode ${mode}: could not resolve an authenticated model`);
		};

		const syncModeForSessionContext = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;

			executionState.refreshFromPersistence();

			const baseline = captureRuntimeProfile(ctx, "default");
			if (baseline !== null) {
				executionState.setDefaultProfile(Option.some(baseline));
				const _result = await applyResolvedProfile(baseline, ctx, {
					notifyOnSuccess: false,
					persist: false,
				});
				return;
			}

			persistModeState("default", undefined, { persist: false });
			emitModeChanged("default");
		};

		const setup = Effect.sync(() => {
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
						const state = executionState.getSnapshot();
						const active = resolveSessionMode(state);
						const presets = await Effect.runPromise(resolvePromptModePresets(ctx.cwd));
						const lines = [
							"Modes:",
							`- default${active === "default" ? " [active]" : ""}`,
							`- smart${active === "smart" ? " [active]" : ""}: ${state.modelsByMode?.smart ?? presets.smart.model} (${presets.smart.thinking})`,
							`- deep${active === "deep" ? " [active]" : ""}: ${state.modelsByMode?.deep ?? presets.deep.model} (${presets.deep.thinking})`,
							`- rush${active === "rush" ? " [active]" : ""}: ${state.modelsByMode?.rush ?? presets.rush.model} (${presets.rush.thinking})`,
							`- plan${active === "plan" ? " [active]" : ""}: ${state.modelsByMode?.plan ?? presets.plan.model} (${presets.plan.thinking})`,
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
				if (
					event.source === "set" &&
					MutableRef.get(suppressModelSelectEventsRef) > 0
				) {
					return;
				}

				const selectedModel = `${event.model.provider}/${event.model.id}`;
				const mode = resolveActiveMode();
				if (mode === "default") {
					const thinking = currentThinkingLevel(pi);
					if (thinking !== undefined) {
						executionState.setDefaultProfile(Option.some({
							mode: "default",
							model: selectedModel,
							thinking,
						}));
					}
					persistModeState("default");
					return;
				}

				persistModeState(mode, selectedModel);
			});

			pi.on("before_agent_start", async (event, ctx) => {
				const baseSystemPrompt = stripInjectedModePrompt(event.systemPrompt);
				const mode = resolveActiveMode();
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

		return ExecutionRuntime.of({
			setup,
			captureCurrentProfile,
			captureCurrentExecutionProfile,
			applyProfile,
			applyExecutionProfile,
		});
	}),
);
