import { describe, expect, it } from "vitest";

import { Effect, Fiber } from "effect";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runTau } from "../src/app.js";

function makePiStub(): ExtensionAPI {
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const registeredRenderers: string[] = [];

	const base = {
		on: () => undefined,
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
			expect(pi.__registeredCommands).toContain("backlog");
			expect(pi.__registeredRenderers).toContain("backlog");
			expect(pi.__registeredTools).not.toContain("bd");
			expect(pi.__registeredCommands).not.toContain("bd");
			expect(pi.__registeredRenderers).not.toContain("bd");
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
});
