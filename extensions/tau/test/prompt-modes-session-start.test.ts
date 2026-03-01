import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, SubscriptionRef } from "effect";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { resolvePromptModePresets, type PromptModeName } from "../src/prompt/modes.js";
import { Persistence } from "../src/services/persistence.js";
import { PromptModes, PromptModesLive } from "../src/services/prompt-modes.js";
import { mergePersistedState, TAU_PERSISTED_STATE_TYPE, type TauPersistedState } from "../src/shared/state.js";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type PiMock = {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, SessionStartHandler[]>;
	readonly setModelCalls: Array<{ readonly provider: string; readonly id: string }>;
	readonly thinkingCalls: string[];
	readonly modeChangedEvents: PromptModeName[];
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

function makePiMock(): PiMock {
	const handlers = new Map<string, SessionStartHandler[]>();
	const setModelCalls: Array<{ readonly provider: string; readonly id: string }> = [];
	const thinkingCalls: string[] = [];
	const modeChangedEvents: PromptModeName[] = [];

	const pi = {
		on: (event: string, handler: unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler as SessionStartHandler);
			handlers.set(event, current);
		},
		registerCommand: () => undefined,
		setModel: async (model: unknown) => {
			if (
				typeof model === "object" &&
				model !== null &&
				typeof (model as { provider?: unknown }).provider === "string" &&
				typeof (model as { id?: unknown }).id === "string"
			) {
				setModelCalls.push({
					provider: (model as { provider: string }).provider,
					id: (model as { id: string }).id,
				});
			}
			return true;
		},
		setThinkingLevel: (level: unknown) => {
			if (typeof level === "string") {
				thinkingCalls.push(level);
			}
		},
		events: {
			emit: (event: string, payload: unknown) => {
				if (
					event === "tau:mode:changed" &&
					typeof payload === "object" &&
					payload !== null &&
					typeof (payload as { mode?: unknown }).mode === "string"
				) {
					const mode = (payload as { mode: string }).mode;
					if (mode === "smart" || mode === "deep" || mode === "rush") {
						modeChangedEvents.push(mode);
					}
				}
			},
			on: () => () => undefined,
		},
	} as unknown as ExtensionAPI;

	return { pi, handlers, setModelCalls, thinkingCalls, modeChangedEvents };
}

function makeSessionStartContext(cwd: string, entries: unknown[], hasUI = true): ExtensionContext {
	return {
		cwd,
		hasUI,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
		},
		sessionManager: {
			getEntries: () => entries,
		},
		ui: {
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
}

async function setupPromptModes(stateRef: SubscriptionRef.SubscriptionRef<TauPersistedState>, pi: ExtensionAPI): Promise<void> {
	const persistenceLayer = Layer.succeed(Persistence, {
		state: stateRef,
		update: (patch: Partial<TauPersistedState>) =>
			SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
		setup: Effect.void,
	});

	const setup = Effect.gen(function* () {
		const promptModes = yield* PromptModes;
		yield* promptModes.setup;
	});

	const layer = PromptModesLive.pipe(Layer.provide(PiAPILive(pi)), Layer.provide(persistenceLayer));
	await Effect.runPromise(setup.pipe(Effect.provide(layer)));
}

describe("prompt-modes session_start", () => {
	it("keeps last used mode when /new session has no persisted mode", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ promptModes: { activeMode: "deep" } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const sessionStart = mock.handlers.get("session_start")?.[0];
			expect(sessionStart).toBeTypeOf("function");

			const ctx = makeSessionStartContext(cwd, []);
			await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

			const deepPreset = resolvePromptModePresets(cwd).deep;
			const expectedModel = parseProviderModel(deepPreset.model);

			expect(mock.setModelCalls.at(-1)).toEqual(expectedModel);
			expect(mock.thinkingCalls.at(-1)).toBe(deepPreset.thinking);
			expect(mock.modeChangedEvents.at(-1)).toBe("deep");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.promptModes?.activeMode).toBe("deep");
		});
	});

	it("prefers session persisted mode over previous in-memory mode", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ promptModes: { activeMode: "deep" } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const sessionStart = mock.handlers.get("session_start")?.[0];
			expect(sessionStart).toBeTypeOf("function");

			const entries = [
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: { promptModes: { activeMode: "smart" } },
				},
			];
			const ctx = makeSessionStartContext(cwd, entries);
			await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

			const smartPreset = resolvePromptModePresets(cwd).smart;
			const expectedModel = parseProviderModel(smartPreset.model);

			expect(mock.setModelCalls.at(-1)).toEqual(expectedModel);
			expect(mock.thinkingCalls.at(-1)).toBe(smartPreset.thinking);
			expect(mock.modeChangedEvents.at(-1)).toBe("smart");

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.promptModes?.activeMode).toBe("smart");
		});
	});

	it("does not override model/thinking in non-interactive mode", async () => {
		await withTempDir(async (cwd) => {
			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ promptModes: { activeMode: "deep" } }),
			);
			const mock = makePiMock();
			await setupPromptModes(stateRef, mock.pi);

			const sessionStart = mock.handlers.get("session_start")?.[0];
			expect(sessionStart).toBeTypeOf("function");

			const ctx = makeSessionStartContext(cwd, [], false);
			await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

			expect(mock.setModelCalls).toHaveLength(0);
			expect(mock.thinkingCalls).toHaveLength(0);
			expect(mock.modeChangedEvents).toHaveLength(0);

			const persisted = Effect.runSync(SubscriptionRef.get(stateRef));
			expect(persisted.promptModes?.activeMode).toBe("deep");
		});
	});
});
