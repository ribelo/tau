import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, SubscriptionRef } from "effect";

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { PromptModes, PromptModesLive } from "../src/services/prompt-modes.js";
import { Persistence } from "../src/services/persistence.js";
import type { TauPersistedState } from "../src/shared/state.js";

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	for (;;) {
		idx = haystack.indexOf(needle, idx);
		if (idx === -1) return count;
		count++;
		idx += needle.length;
	}
}

describe("AGENTS.md availability", () => {
	it("is preserved when mode prompt is appended via before_agent_start", async () => {
		await withTempDir(async (cwd) => {
			const agentsPath = path.join(cwd, "AGENTS.md");
			await fs.writeFile(agentsPath, "AGENTS_TEST_MARKER\n", "utf8");

			// Build the base system prompt the same way pi does (resource loader -> buildSystemPrompt).
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: new AuthStorage(),
				modelRegistry: new ModelRegistry(new AuthStorage()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			});

			const basePrompt = session.systemPrompt;
			expect(basePrompt).toContain(agentsPath);
			expect(basePrompt).toContain("AGENTS_TEST_MARKER");

			// Capture before_agent_start handler installed by PromptModesLive.
			let beforeAgentStartHandler:
				| ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown)
				| undefined;

			const pi = {
				on: (event: string, handler: unknown) => {
					if (event === "before_agent_start") {
						beforeAgentStartHandler = handler as (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;
					}
				},
				registerCommand: () => undefined,
				// The rest of ExtensionAPI is not exercised by this test.
			} as unknown as ExtensionAPI;

			const stateRef = await Effect.runPromise(
				SubscriptionRef.make<TauPersistedState>({ promptModes: { activeMode: "smart" } }),
			);

			const persistenceLayer = Layer.succeed(Persistence, {
				state: stateRef,
				update: () => Effect.void,
				setup: Effect.void,
			});

			const setup = Effect.gen(function* () {
				const pm = yield* PromptModes;
				yield* pm.setup;
			});

			const layer = PromptModesLive.pipe(
				Layer.provide(PiAPILive(pi)),
				Layer.provide(persistenceLayer),
			);

			await Effect.runPromise(setup.pipe(Effect.provide(layer)));

			expect(beforeAgentStartHandler).toBeTypeOf("function");

			const ctx = {
				cwd,
			} as unknown as ExtensionContext;

			const event1: BeforeAgentStartEvent = {
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: basePrompt,
			};

			const result1 = beforeAgentStartHandler?.(event1, ctx) as { systemPrompt?: string } | undefined;
			const injected1 = result1?.systemPrompt;
			expect(injected1).toBeTypeOf("string");
			expect(injected1).toContain("AGENTS_TEST_MARKER");

			// Simulate a second before_agent_start call where pi passes a prompt that already
			// includes the mode prompt. The handler must not double-inject.
			const event2: BeforeAgentStartEvent = {
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: injected1 ?? basePrompt,
			};

			const result2 = beforeAgentStartHandler?.(event2, ctx) as { systemPrompt?: string } | undefined;
			const injected2 = result2?.systemPrompt;
			expect(injected2).toBeTypeOf("string");
			expect(injected2).toContain("AGENTS_TEST_MARKER");

			// Ensure the mode prompt is injected exactly once (not repeated on subsequent calls).
			// We detect this by checking the second output didn't grow with another copy.
			expect(injected2).toBe(injected1);

			// Sanity: system prompt still includes exactly one AGENTS marker.
			expect(countOccurrences(injected2 ?? "", "AGENTS_TEST_MARKER")).toBe(1);
		});
	});

	it("is available in agent sessions created for subagents", async () => {
		await withTempDir(async (cwd) => {
			const agentsPath = path.join(cwd, "AGENTS.md");
			await fs.writeFile(agentsPath, "AGENTS_TEST_MARKER\n", "utf8");

			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: new AuthStorage(),
				modelRegistry: new ModelRegistry(new AuthStorage()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			});

			expect(session.systemPrompt).toContain(agentsPath);
			expect(session.systemPrompt).toContain("AGENTS_TEST_MARKER");
		});
	});
});
