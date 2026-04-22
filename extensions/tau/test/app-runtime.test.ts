import { describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Fiber } from "effect";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runTau } from "../src/app.js";
import tau from "../src/index.js";

function makePiStub(): ExtensionAPI {
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const registeredRenderers: string[] = [];
	let editorSetCount = 0;

	const base = {
		on: (event: string, handler: (payload: unknown, ctx?: unknown) => unknown) => {
			const list = eventHandlers.get(event) ?? [];
			list.push(handler);
			eventHandlers.set(event, list);
		},
		registerTool: (tool: unknown) => {
			if (
				typeof tool === "object" &&
				tool !== null &&
				"name" in tool &&
				typeof tool.name === "string"
			) {
				registeredTools.push(tool.name);
			}
		},
		registerCommand: (name: unknown) => {
			if (typeof name === "string") {
				registeredCommands.push(name);
			}
		},
		registerShortcut: () => undefined,
		registerMessageRenderer: (name: unknown) => {
			if (typeof name === "string") {
				registeredRenderers.push(name);
			}
		},
		registerFlag: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getActiveTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		events: {
			emit: (event: string, payload: unknown) => {
				for (const handler of eventHandlers.get(event) ?? []) {
					handler(payload);
				}
			},
			on: (event: string, handler: (payload: unknown) => void) => {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
				return () => {
					eventHandlers.set(
						event,
						(eventHandlers.get(event) ?? []).filter((entry) => entry !== handler),
					);
				};
			},
		},
	};

	const proxy = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI & {
		readonly __registeredTools: string[];
		readonly __registeredCommands: string[];
		readonly __registeredRenderers: string[];
	};

	Object.defineProperties(proxy, {
		__registeredTools: { value: registeredTools, enumerable: false },
		__registeredCommands: { value: registeredCommands, enumerable: false },
		__registeredRenderers: { value: registeredRenderers, enumerable: false },
		__eventHandlers: { value: eventHandlers, enumerable: false },
		__editorSetCount: {
			get: () => editorSetCount,
			enumerable: false,
		},
	});

	return proxy;
}

describe("runTau runtime", () => {
	it("registers backlog-only planning surfaces during startup", async () => {
		const pi = makePiStub() as ExtensionAPI & {
			readonly __registeredTools: string[];
			readonly __registeredCommands: string[];
			readonly __registeredRenderers: string[];
		};
		const fiber = runTau(pi);

		try {
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(pi.__registeredTools).toContain("backlog");
			expect(pi.__registeredTools).toContain("autoresearch_run");
			expect(pi.__registeredTools).toContain("autoresearch_done");
			expect(pi.__registeredTools).not.toContain("init_experiment");
			expect(pi.__registeredTools).not.toContain("run_experiment");
			expect(pi.__registeredTools).not.toContain("log_experiment");
			expect(pi.__registeredCommands).toContain("backlog");
			expect(pi.__registeredRenderers).toContain("backlog");
			expect(pi.__registeredTools).not.toContain("bd");
			expect(pi.__registeredCommands).not.toContain("bd");
			expect(pi.__registeredRenderers).not.toContain("bd");
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});

	it("registers the dream command during startup", async () => {
		const pi = makePiStub() as ExtensionAPI & {
			readonly __registeredCommands: string[];
		};
		const fiber = runTau(pi);

		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(pi.__registeredCommands).toContain("dream");
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});

	it("keeps the scoped runtime alive for background loops", async () => {
		const fiber = runTau(makePiStub());

		try {
			await new Promise((resolve) => setTimeout(resolve, 200));

			await expect(
				Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeout("20 millis"))),
			).rejects.toThrow();
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});

	it("does not resolve extension startup until late commands and editor session handlers are registered", async () => {
		const pi = makePiStub() as ExtensionAPI & {
			readonly __registeredCommands: string[];
			readonly __eventHandlers: Map<string, Array<(payload: unknown, ctx?: unknown) => unknown>>;
			readonly __editorSetCount: number;
		};

		const startup = tau(pi);
		await startup;

		expect(pi.__registeredCommands).toContain("mode");
		expect(pi.__registeredCommands).toContain("memories");

		const sessionStartHandlers = pi.__eventHandlers.get("session_start") ?? [];
		expect(sessionStartHandlers.length).toBeGreaterThan(0);
		let editorSetCount = 0;

		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
			},
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionId: () => "test-session",
			},
			ui: {
				setEditorComponent: () => {
					editorSetCount += 1;
				},
				setFooter: () => () => undefined,
				setWidget: () => undefined,
				notify: () => undefined,
				getEditorText: () => "",
			},
			isIdle: () => true,
			hasPendingMessages: () => false,
			abort: () => undefined,
			shutdown: () => undefined,
			getContextUsage: () => undefined,
			compact: () => undefined,
			getSystemPrompt: () => "",
		} as unknown;

		for (const handler of sessionStartHandlers) {
			await Promise.resolve(handler({ type: "session_start" }, ctx));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(editorSetCount).toBeGreaterThan(0);
	});

	it("runs Ralph session shutdown before app runtime disposal", async () => {
		const pi = makePiStub() as ExtensionAPI & {
			readonly __eventHandlers: Map<string, Array<(payload: unknown, ctx?: unknown) => unknown>>;
		};

		const startup = tau(pi);
		await startup;

		const sessionShutdownHandlers = pi.__eventHandlers.get("session_shutdown") ?? [];
		expect(sessionShutdownHandlers.length).toBeGreaterThan(1);

		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionId: () => "test-session",
				getSessionFile: () => undefined,
			},
			ui: {
				setStatus: () => undefined,
				setWidget: () => undefined,
				notify: () => undefined,
				setFooter: () => () => undefined,
				getEditorText: () => "",
			},
		} as unknown;

		for (const handler of sessionShutdownHandlers) {
			await expect(Promise.resolve(handler({ type: "session_shutdown" }, ctx))).resolves.toBeUndefined();
		}
	});

	it("fails startup when resolved agent configuration is invalid", async () => {
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-home-"));

		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						deep: {
							tools: ["read", "imaginary_tool"],
						},
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		vi.stubEnv("HOME", tempHome);

		try {
			await expect(tau(makePiStub())).rejects.toThrow(
				'Invalid tools for agent "deep": imaginary_tool',
			);
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
