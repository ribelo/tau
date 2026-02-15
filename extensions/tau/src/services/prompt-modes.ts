import { Context, Effect, Layer, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import { DEFAULT_PROMPT_MODE_PRESETS, isPromptModeName, type PromptModeName } from "../prompt/modes.js";
import { Persistence } from "./persistence.js";
import type { TauPersistedState } from "../shared/state.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export interface PromptModes {
	readonly setup: Effect.Effect<void>;
}

export const PromptModes = Context.GenericTag<PromptModes>("PromptModes");

function resolveActiveMode(state: { promptModes?: { activeMode?: PromptModeName } } | undefined): PromptModeName {
	const active = state?.promptModes?.activeMode;
	return active ?? "smart";
}

function parseProviderModelOrThrow(model: string): { readonly provider: string; readonly modelId: string } {
	const idx = model.indexOf("/");
	if (idx <= 0 || idx >= model.length - 1) {
		throw new Error(
			`Invalid model id: "${model}" - must be "provider/model-id" (e.g. "openai-codex/gpt-5.3-codex")`,
		);
	}
	return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}

async function applyMode(
	pi: ExtensionAPI,
	persistence: { readonly update: (patch: Partial<TauPersistedState>) => Effect.Effect<void> },
	mode: PromptModeName,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const preset = DEFAULT_PROMPT_MODE_PRESETS[mode];
	const { provider, modelId } = parseProviderModelOrThrow(preset.model);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`Mode ${mode}: model not found: ${preset.model}`, "error");
		return;
	}

	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`Mode ${mode}: no auth available for ${preset.model}`, "error");
		return;
	}

	pi.setThinkingLevel(preset.thinking);
	await Effect.runPromise(persistence.update({ promptModes: { activeMode: mode } }));
	pi.events.emit("tau:mode:changed", { mode });
	ctx.ui.notify(`Mode: ${mode}`, "info");
}

export const PromptModesLive = Layer.effect(
	PromptModes,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return PromptModes.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					pi.registerCommand("mode", {
						description: "Prompt mode: /mode [smart|deep|rush|list]",
						handler: async (args, ctx) => {
							const trimmed = (args || "").trim();

							if (!trimmed) {
								if (!ctx.hasUI) {
									const state = SubscriptionRef.get(persistence.state).pipe(Effect.runSync);
									ctx.ui.notify(
										`Mode: ${resolveActiveMode(state)}. Usage: /mode smart|deep|rush|list`,
										"info",
									);
									return;
								}

								const choice = await ctx.ui.select("Mode", ["smart", "deep", "rush"]);
								if (!choice) return;
								if (!isPromptModeName(choice)) {
									ctx.ui.notify(`Invalid mode: ${choice}`, "error");
									return;
								}

								await applyMode(pi, persistence, choice, ctx);
								return;
							}

							if (trimmed === "list") {
								const lines = [
									"Modes:",
									`- smart: ${DEFAULT_PROMPT_MODE_PRESETS.smart.model} (${DEFAULT_PROMPT_MODE_PRESETS.smart.thinking})`,
									`- deep: ${DEFAULT_PROMPT_MODE_PRESETS.deep.model} (${DEFAULT_PROMPT_MODE_PRESETS.deep.thinking})`,
									`- rush: ${DEFAULT_PROMPT_MODE_PRESETS.rush.model} (${DEFAULT_PROMPT_MODE_PRESETS.rush.thinking})`,
								];
								ctx.ui.notify(lines.join("\n"), "info");
								return;
							}

							const lower = trimmed.toLowerCase();
							if (!isPromptModeName(lower)) {
								ctx.ui.notify("Usage: /mode smart|deep|rush|list", "info");
								return;
							}

							await applyMode(pi, persistence, lower, ctx);
						},
					});

					pi.on("before_agent_start", (event) => {
						const state = SubscriptionRef.get(persistence.state).pipe(Effect.runSync);
						const mode = resolveActiveMode(state);
						const preset = DEFAULT_PROMPT_MODE_PRESETS[mode];
						return {
							systemPrompt: `${event.systemPrompt}\n\n${preset.systemPrompt}`,
						};
					});
				});
			}),
		});
	}),
);
