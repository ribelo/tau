import { Context, Effect, Layer, SubscriptionRef } from "effect";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { PiAPI } from "../effect/pi.js";
import { isPromptModeName, resolvePromptModePresets, type PromptModeName } from "../prompt/modes.js";
import type { TauPersistedState } from "../shared/state.js";
import { Persistence } from "./persistence.js";

export interface PromptModes {
	readonly setup: Effect.Effect<void>;
}

export const PromptModes = Context.GenericTag<PromptModes>("PromptModes");

function resolvePersistedMode(state: { promptModes?: { activeMode?: PromptModeName } } | undefined): PromptModeName {
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
	const presets = resolvePromptModePresets(ctx.cwd);
	const preset = presets[mode];
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
					let baseSystemPrompt: string | undefined = undefined;

					pi.registerCommand("mode", {
						description: "Prompt mode: /mode [smart|deep|rush|list]",
						handler: async (args, ctx) => {
							const trimmed = (args || "").trim();

							if (!trimmed) {
								if (!ctx.hasUI) {
									const state = SubscriptionRef.get(persistence.state).pipe(Effect.runSync);
									ctx.ui.notify(
										`Mode: ${resolvePersistedMode(state)}. Usage: /mode smart|deep|rush|list`,
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
								const state = SubscriptionRef.get(persistence.state).pipe(Effect.runSync);
								const active = resolvePersistedMode(state);
								const presets = resolvePromptModePresets(ctx.cwd);
								const lines = [
									"Modes:",
									`- smart${active === "smart" ? " [active]" : ""}: ${presets.smart.model} (${presets.smart.thinking})`,
									`- deep${active === "deep" ? " [active]" : ""}: ${presets.deep.model} (${presets.deep.thinking})`,
									`- rush${active === "rush" ? " [active]" : ""}: ${presets.rush.model} (${presets.rush.thinking})`,
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

					pi.on("before_agent_start", (event, ctx) => {
						// pi may call before_agent_start multiple times (e.g. model switches). Always rebuild
						// from the original base prompt so the mode prompt is injected exactly once.
						if (baseSystemPrompt === undefined) baseSystemPrompt = event.systemPrompt;

						const state = SubscriptionRef.get(persistence.state).pipe(Effect.runSync);
						const mode = resolvePersistedMode(state);
						const presets = resolvePromptModePresets(ctx.cwd);
						const preset = presets[mode];
						return { systemPrompt: `${baseSystemPrompt}\n\n${preset.systemPrompt}` };
					});
				});
			}),
		});
	}),
);
