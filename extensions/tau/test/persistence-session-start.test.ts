import { describe, expect, it } from "vitest";

import { Effect, Layer } from "effect";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { Persistence, PersistenceLive } from "../src/services/persistence.js";
import { TAU_PERSISTED_STATE_TYPE, type TauPersistedState } from "../src/shared/state.js";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type PiMock = {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, SessionStartHandler[]>;
};

function makePiMock(): PiMock {
	const handlers = new Map<string, SessionStartHandler[]>();
	const pi = {
		on: (event: string, handler: unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler as SessionStartHandler);
			handlers.set(event, current);
		},
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function makeSessionStartContext(entries: unknown[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "test-session",
		},
	} as unknown as ExtensionContext;
}

async function setupPersistence(pi: ExtensionAPI): Promise<{
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
}> {
	const program = Effect.gen(function* () {
		const persistence = yield* Persistence;
		yield* persistence.setup;
		return persistence;
	});
	const layer = PersistenceLive.pipe(Layer.provide(PiAPILive(pi)));
	return Effect.runPromise(program.pipe(Effect.provide(layer)));
}

describe("persistence session_start", () => {
	it("keeps existing prompt mode when session has no tau state", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);
		persistence.update({ promptModes: { activeMode: "deep" } });

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([]);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

		const state = persistence.getSnapshot();
		expect(state.promptModes?.activeMode).toBe("deep");
	});

	it("prefers session prompt mode when tau state contains one", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);
		persistence.update({ promptModes: { activeMode: "deep" } });

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { promptModes: { activeMode: "smart" } },
			},
		]);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

		const state = persistence.getSnapshot();
		expect(state.promptModes?.activeMode).toBe("smart");
	});

	it("keeps existing prompt mode when session tau state has empty promptModes", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);
		persistence.update({ promptModes: { activeMode: "deep" } });

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { promptModes: {} },
			},
		]);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

		const state = persistence.getSnapshot();
		expect(state.promptModes?.activeMode).toBe("deep");
	});
});
