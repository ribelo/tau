import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, SubscriptionRef } from "effect";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { resolvePromptModePresets, type PromptModeName } from "../src/prompt/modes.js";
import { Persistence } from "../src/services/persistence.js";
import { ExecutionState, ExecutionStateLive } from "../src/services/execution-state.js";
import { ExecutionRuntimeLive } from "../src/services/execution-runtime.js";
import { PromptModes, PromptModesLive } from "../src/services/prompt-modes.js";
import {
	loadPersistedState,
	mergePersistedState,
	TAU_PERSISTED_STATE_TYPE,
	type TauPersistedState,
} from "../src/shared/state.js";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

type ModelRef = {
	readonly provider: string;
	readonly id: string;
};

type PiMock = {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, SessionStartHandler[]>;
	readonly commands: Map<string, CommandHandler>;
	readonly shortcuts: Map<string, ShortcutHandler>;
	readonly setModelCalls: Array<ModelRef>;
	readonly thinkingCalls: string[];
	readonly modeChangedEvents: PromptModeName[];
	readonly seedCurrentModel: (model: ModelRef) => void;
	readonly getCurrentModel: () => ModelRef | undefined;
	readonly getCurrentThinking: () => string;
};

type PiMockOptions = {
	readonly emitModelSelectOnSet?: boolean;
	readonly getSetModelContext?: () => ExtensionContext | undefined;
};

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function parseProviderModel(model: string): { readonly provider: string; readonly id: string } {
	const idx = model.indexOf("/");
	if (idx <= 0 || idx >= model.length - 1) {
		throw new Error(`Invalid model: ${model}`);
	}
	return { provider: model.slice(0, idx), id: model.slice(idx + 1) };
}

function makePiMock(options?: PiMockOptions): PiMock {
	const handlers = new Map<string, SessionStartHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const shortcuts = new Map<string, ShortcutHandler>();
	const setModelCalls: Array<ModelRef> = [];
	const thinkingCalls: string[] = [];
	const modeChangedEvents: PromptModeName[] = [];
	let currentModel: ModelRef | undefined = undefined;
	let currentThinking = "medium";

	const pi = {
		on: (event: string, handler: unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler as SessionStartHandler);
			handlers.set(event, current);
		},
		registerCommand: (name: string, options: unknown) => {
			if (
				typeof options === "object" &&
				options !== null &&
				typeof (options as { handler?: unknown }).handler === "function"
			) {
				commands.set(name, (options as { handler: CommandHandler }).handler);
			}
		},
		registerShortcut: (shortcut: string, options: unknown) => {
			if (
				typeof options === "object" &&
				options !== null &&
				typeof (options as { handler?: unknown }).handler === "function"
			) {
				shortcuts.set(shortcut, (options as { handler: ShortcutHandler }).handler);
			}
		},
		setModel: async (model: unknown) => {
			if (
				typeof model === "object" &&
				model !== null &&
				typeof (model as { provider?: unknown }).provider === "string" &&
				typeof (model as { id?: unknown }).id === "string"
			) {
				const selectedModel = {
					provider: (model as { provider: string }).provider,
					id: (model as { id: string }).id,
				};
				setModelCalls.push(selectedModel);

				if (options?.emitModelSelectOnSet) {
					const ctx = options.getSetModelContext?.();
					if (ctx) {
						const modelSelectHandlers = handlers.get("model_select") ?? [];
						for (const handler of modelSelectHandlers) {
							await Promise.resolve(
								handler(
									{
										type: "model_select",
										model: selectedModel,
										previousModel: currentModel,
										source: "set",
									},
									ctx,
								),
							);
						}
					}
				}

				currentModel = selectedModel;
			}
			return true;
		},
		setThinkingLevel: (level: unknown) => {
			if (typeof level === "string") {
				thinkingCalls.push(level);
				currentThinking = level;
			}
		},
		getThinkingLevel: () => currentThinking,
		events: {
			emit: (event: string, payload: unknown) => {
				if (
					event === "tau:mode:changed" &&
					typeof payload === "object" &&
					payload !== null &&
					typeof (payload as { mode?: unknown }).mode === "string"
				) {
					const mode = (payload as { mode: string }).mode;
					if (
						mode === "default" ||
						mode === "smart" ||
						mode === "deep" ||
						mode === "rush"
					) {
						modeChangedEvents.push(mode);
					}
				}
			},
			on: () => () => undefined,
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		handlers,
		commands,
		shortcuts,
		setModelCalls,
		thinkingCalls,
		modeChangedEvents,
		seedCurrentModel: (model) => {
			currentModel = model;
		},
		getCurrentModel: () => currentModel,
		getCurrentThinking: () => currentThinking,
	};
}

function makeSessionStartContext(
	cwd: string,
	entries: unknown[],
	hasUI = true,
	options?: {
		readonly editorText?: string;
		readonly isIdle?: boolean;
		readonly hasPendingMessages?: boolean;
		readonly model?: ModelRef;
		readonly selectChoice?: string;
	},
): ExtensionContext {
	const editorText = options?.editorText ?? "";
	const isIdle = options?.isIdle ?? true;
	const hasPendingMessages = options?.hasPendingMessages ?? false;
	const model = options?.model;
	const selectChoice = options?.selectChoice;

	return {
		cwd,
		hasUI,
		model,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
		},
		sessionManager: {
			getEntries: () => entries,
		},
		isIdle: () => isIdle,
		hasPendingMessages: () => hasPendingMessages,
		abort: () => undefined,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			notify: () => undefined,
			select: async () => selectChoice,
			getEditorText: () => editorText,
		},
	} as unknown as ExtensionContext;
}

async function setupPromptModes(
	stateRef: SubscriptionRef.SubscriptionRef<TauPersistedState>,
	pi: ExtensionAPI,
): Promise<void> {
	await Effect.runPromise(
		SubscriptionRef.update(stateRef, (current) => mergePersistedState({}, current)),
	);

	const persistenceLayer = Layer.succeed(Persistence, {
		getSnapshot: () => Effect.runSync(SubscriptionRef.get(stateRef)),
		setSnapshot: (next: TauPersistedState) => {
			Effect.runSync(SubscriptionRef.set(stateRef, next));
		},
		hydrate: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(
				SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
			);
		},
		update: (patch: Partial<TauPersistedState>) => {
				Effect.runSync(
					SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
				);
		},
		getSnapshotEffect: SubscriptionRef.get(stateRef),
		setSnapshotEffect: (next: TauPersistedState) => SubscriptionRef.set(stateRef, next),
		updateEffect: (patch: Partial<TauPersistedState>) =>
			SubscriptionRef.updateAndGet(stateRef, (current) => mergePersistedState(current, patch)),
		changes: SubscriptionRef.changes(stateRef),
		setup: Effect.sync(() => {
			const mergePersistedFromContext = (_event: unknown, ctx: ExtensionContext) => {
				Effect.runSync(
					SubscriptionRef.update(stateRef, (current) =>
						mergePersistedState(current, loadPersistedState(ctx)),
					),
				);
			};

			pi.on("session_start", mergePersistedFromContext);
			pi.on("session_switch", mergePersistedFromContext);
		}),
	});

	const setup = Effect.gen(function* () {
		const persistence = yield* Persistence;
		yield* persistence.setup;
		const executionState = yield* ExecutionState;
		yield* executionState.setup;
		const promptModes = yield* PromptModes;
		yield* promptModes.setup;
	});
	const executionStateLayer = ExecutionStateLive.pipe(Layer.provide(persistenceLayer));
	const executionRuntimeLayer = ExecutionRuntimeLive.pipe(
		Layer.provide(executionStateLayer),
	);

	const layer = Layer.mergeAll(
		persistenceLayer,
		executionStateLayer,
		executionRuntimeLayer,
		PromptModesLive.pipe(Layer.provide(executionRuntimeLayer)),
	).pipe(Layer.provide(PiAPILive(pi)));
	await Effect.runPromise(Effect.scoped(setup.pipe(Effect.provide(layer))));
}

async function runWithPromptModes<A>(
	stateRef: SubscriptionRef.SubscriptionRef<TauPersistedState>,
	pi: ExtensionAPI,
	effect: (promptModes: PromptModes) => Effect.Effect<A>,
): Promise<A> {
	const persistenceLayer = Layer.succeed(Persistence, {
		getSnapshot: () => Effect.runSync(SubscriptionRef.get(stateRef)),
		setSnapshot: (next: TauPersistedState) => {
			Effect.runSync(SubscriptionRef.set(stateRef, next));
		},
		hydrate: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(
				SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
			);
		},
		update: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(
				SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
			);
		},
		getSnapshotEffect: SubscriptionRef.get(stateRef),
		setSnapshotEffect: (next: TauPersistedState) => SubscriptionRef.set(stateRef, next),
		updateEffect: (patch: Partial<TauPersistedState>) =>
			SubscriptionRef.updateAndGet(stateRef, (current) => mergePersistedState(current, patch)),
		changes: SubscriptionRef.changes(stateRef),
		setup: Effect.sync(() => undefined),
	});

	const executionStateLayer = ExecutionStateLive.pipe(Layer.provide(persistenceLayer));
	const executionRuntimeLayer = ExecutionRuntimeLive.pipe(Layer.provide(executionStateLayer));
	const layer = Layer.mergeAll(
		persistenceLayer,
		executionStateLayer,
		executionRuntimeLayer,
		PromptModesLive.pipe(Layer.provide(executionRuntimeLayer)),
	).pipe(Layer.provide(PiAPILive(pi)));

	return await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const executionState = yield* ExecutionState;
				yield* executionState.setup;
				const promptModes = yield* PromptModes;
				yield* promptModes.setup;
				return yield* effect(promptModes);
			}).pipe(Effect.provide(layer)),
		),
	);
}

async function dispatchLifecycleEvent(
	mock: PiMock,
	event: "session_start" | "session_switch",
	payload: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const handlers = mock.handlers.get(event) ?? [];
	expect(handlers.length).toBeGreaterThan(0);
	for (const handler of handlers) {
		await Promise.resolve(handler(payload, ctx));
	}
}

describe("prompt-modes session_start", () => {
	it("starts in default mode when /new session has no persisted mode", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ execution: { selector: { mode: "deep" } } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const ctx = makeSessionStartContext(cwd, []);
			await dispatchLifecycleEvent(mock, "session_start", { type: "session_start" }, ctx);

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents.at(-1)).toBe("default");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
		});
	});

	it("ignores session persisted mode and starts in default mode", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ execution: { selector: { mode: "deep" } } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const entries = [
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: { execution: { selector: { mode: "smart" } } },
				},
			];
			const ctx = makeSessionStartContext(cwd, entries);
			await dispatchLifecycleEvent(mock, "session_start", { type: "session_start" }, ctx);

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents.at(-1)).toBe("default");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
		});
	});

	it("restores per-mode model assignments without activating them on session_start", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(SubscriptionRef.make<TauPersistedState>({}));
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const entries = [
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: {
						execution: {
							selector: { mode: "deep" },
							modelsByMode: {
								deep: "openai-codex/gpt-5.3-codex",
							},
						},
					},
				},
			];
			const ctx = makeSessionStartContext(cwd, entries);
			await dispatchLifecycleEvent(mock, "session_start", { type: "session_start" }, ctx);

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents.at(-1)).toBe("default");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
			expect(persisted.execution?.modelsByMode?.deep).toBe("openai-codex/gpt-5.3-codex");
		});
	});

	it("updates the active mode assignment on model_select", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ execution: { selector: { mode: "rush" } } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const modelSelect = mock.handlers.get("model_select")?.[0];
			expect(modelSelect).toBeTypeOf("function");

			const ctx = makeSessionStartContext(cwd, []);
			await Promise.resolve(
				modelSelect?.(
					{
						type: "model_select",
						model: { provider: "anthropic", id: "claude-opus-4-5" },
						previousModel: undefined,
						source: "set",
					},
					ctx,
				),
			);

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("rush");
			expect(persisted.execution?.modelsByMode?.rush).toBe("anthropic/claude-opus-4-5");
		});
	});

	it("starts in default mode on session_switch while preserving per-mode assignments", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ execution: { selector: { mode: "smart" } } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const entries = [
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: {
						execution: {
							selector: { mode: "rush" },
							modelsByMode: {
								rush: "kimi-coding/kimi-k2-thinking",
							},
						},
					},
				},
			];
			const ctx = makeSessionStartContext(cwd, entries);
			await dispatchLifecycleEvent(
				mock,
				"session_switch",
				{ type: "session_switch", reason: "resume" },
				ctx,
			);

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents.at(-1)).toBe("default");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
			expect(persisted.execution?.modelsByMode?.rush).toBe("kimi-coding/kimi-k2-thinking");
		});
	});

	it("keeps per-mode model assignments across explicit mode switches and restart", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({
					execution: {
						selector: { mode: "smart" },
					},
				}),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const modelSelect = mock.handlers.get("model_select")?.[0];
			const modeCommand = mock.commands.get("mode");
			expect(modelSelect).toBeTypeOf("function");
			expect(modeCommand).toBeTypeOf("function");

			// Assign a non-default model while smart mode is active.
			await Promise.resolve(
				modelSelect?.(
					{
						type: "model_select",
						model: { provider: "openai-codex", id: "gpt-5.3-codex" },
						previousModel: undefined,
						source: "set",
					},
					makeSessionStartContext(cwd, []),
				),
			);

			let persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.modelsByMode?.smart).toBe("openai-codex/gpt-5.3-codex");


			await Promise.resolve(
				modeCommand?.("deep", makeSessionStartContext(cwd, []) as ExtensionCommandContext),
			);

			await Promise.resolve(
				modelSelect?.(
					{
						type: "model_select",
						model: { provider: "kimi-coding", id: "kimi-k2-thinking" },
						previousModel: undefined,
						source: "set",
					},
					makeSessionStartContext(cwd, [
						{
							type: "custom",
							customType: TAU_PERSISTED_STATE_TYPE,
							data: {
								execution: {
									selector: { mode: "deep" },
									modelsByMode: {
										smart: "openai-codex/gpt-5.3-codex",
										deep: "anthropic/claude-opus-4-5",
									},
								},
							},
						},
					]),
				),
			);

			persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.modelsByMode?.deep).toBe("kimi-coding/kimi-k2-thinking");
			expect(persisted.execution?.modelsByMode?.smart).toBe("openai-codex/gpt-5.3-codex");

			// Restart should return to default mode instead of restoring a saved mode.
			await dispatchLifecycleEvent(
				mock,
				"session_switch",
				{ type: "session_switch", reason: "resume" },
				makeSessionStartContext(cwd, [
					{
						type: "custom",
						customType: TAU_PERSISTED_STATE_TYPE,
						data: {
							execution: {
								selector: { mode: "smart" },
								modelsByMode: {
									smart: "openai-codex/gpt-5.3-codex",
									deep: "kimi-coding/kimi-k2-thinking",
								},
							},
						},
					},
				]),
			);

			expect(mock.modeChangedEvents.at(-1)).toBe("default");
			persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
			expect(persisted.execution?.modelsByMode?.smart).toBe("openai-codex/gpt-5.3-codex");
			expect(persisted.execution?.modelsByMode?.deep).toBe("kimi-coding/kimi-k2-thinking");
		});
	});

	it("does not override model or thinking when default mode is active", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({
					execution: {
						selector: { mode: "default" },
						modelsByMode: {
							smart: "anthropic/claude-opus-4-5",
						},
					},
				}),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const ctx = makeSessionStartContext(cwd, []);
			await dispatchLifecycleEvent(mock, "session_start", { type: "session_start" }, ctx);

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents.at(-1)).toBe("default");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
			expect(persisted.execution?.modelsByMode?.smart).toBe("anthropic/claude-opus-4-5");
		});
	});

	it("restores the captured default profile instead of keeping the active mode model", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(SubscriptionRef.make<TauPersistedState>({}));
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const modeCommand = mock.commands.get("mode");
			expect(modeCommand).toBeTypeOf("function");

			const presets = await Effect.runPromise(resolvePromptModePresets(cwd));
			const deepModel = parseProviderModel(presets.deep.model);
			const deepThinking = presets.deep.thinking;
			const defaultModel = parseProviderModel("anthropic/claude-opus-4-5");
			const defaultCtx = makeSessionStartContext(cwd, [], true, { model: defaultModel });
			await dispatchLifecycleEvent(
				mock,
				"session_start",
				{ type: "session_start" },
				defaultCtx,
			);

			await Promise.resolve(modeCommand?.("deep", defaultCtx as ExtensionCommandContext));
			expect(mock.setModelCalls.at(-1)).toEqual(deepModel);
			expect(mock.thinkingCalls.at(-1)).toBe(deepThinking);

			const currentModel = mock.getCurrentModel();
			expect(currentModel).toEqual(deepModel);

			const defaultReturnCtx = makeSessionStartContext(
				cwd,
				[],
				true,
				currentModel === undefined ? undefined : { model: currentModel },
			);
			await Promise.resolve(modeCommand?.("default", defaultReturnCtx as ExtensionCommandContext));

			expect(mock.setModelCalls.at(-1)).toEqual(defaultModel);
			expect(mock.thinkingCalls.at(-1)).toBe("medium");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("default");
		});
	});

	it("does not register a tab shortcut that conflicts with pi built-ins", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ execution: { selector: { mode: "smart" } } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			void cwd;

			expect(mock.shortcuts.has("tab")).toBe(false);
		});
	});

	it("does not override model/thinking in non-interactive mode", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ execution: { selector: { mode: "deep" } } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const ctx = makeSessionStartContext(cwd, [], false);
			await dispatchLifecycleEvent(mock, "session_start", { type: "session_start" }, ctx);

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents).toHaveLength(0);

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.execution?.selector?.mode).toBe("deep");
		});
	});

	it("forces model selection for ephemeral execution-profile application even when ctx.model is stale", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(SubscriptionRef.make<TauPersistedState>({}));
			const mock = makePiMock();

			mock.seedCurrentModel({ provider: "moonshot", id: "kimi-for-coding" });
			mock.setModelCalls.length = 0;

			const result = await runWithPromptModes(stateRef, mock.pi, (promptModes) =>
				promptModes.applyExecutionProfile(
					{
						selector: { mode: "deep" },
						promptProfile: {
							mode: "deep",
							model: "openai-codex/gpt-5.4",
							thinking: "high",
						},
						policy: { tools: { kind: "inherit" } },
					},
					makeSessionStartContext(cwd, [], true, {
						model: { provider: "openai-codex", id: "gpt-5.4" },
					}),
					{ persist: false, ephemeral: true },
				),
			);

			expect(result.applied).toBe(true);
			expect(mock.setModelCalls).toEqual([{ provider: "openai-codex", id: "gpt-5.4" }]);
		});
	});
});
