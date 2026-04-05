import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import initAgentsMenu from "../src/agents-menu/index.js";

type EventHandler = (event: unknown, ctx: { cwd: string; hasUI: boolean }) => unknown;

type RegisteredCommand = {
	readonly name: string;
	readonly description: string;
};

function makePiStub(): {
	readonly pi: ExtensionAPI;
	readonly commands: RegisteredCommand[];
	readonly handlers: Map<string, EventHandler[]>;
	readonly setActiveToolsCalls: string[][];
} {
	const commands: RegisteredCommand[] = [];
	const handlers = new Map<string, EventHandler[]>();
	const setActiveToolsCalls: string[][] = [];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand: (name: string, command: { description: string }) => {
			commands.push({ name, description: command.description });
		},
		getActiveTools: () => ["agent"],
		setActiveTools: (tools: string[]) => {
			setActiveToolsCalls.push([...tools]);
		},
	} as const;

	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;

	return { pi, commands, handlers, setActiveToolsCalls };
}

describe("agents menu", () => {
	it("describes /agents as session-scoped", () => {
		const { pi, commands } = makePiStub();

		initAgentsMenu(pi, {
			refresh: () => undefined,
		});

		expect(commands).toContainEqual({
			name: "agents",
			description: "Enable/disable agents for this session",
		});
	});

	it("does not recompute global tool availability on non-UI session_start", async () => {
		const { pi, handlers, setActiveToolsCalls } = makePiStub();
		let refreshCount = 0;

		initAgentsMenu(pi, {
			refresh: () => {
				refreshCount += 1;
			},
		});

		const refreshBaseline = refreshCount;
		const setActiveToolsBaseline = setActiveToolsCalls.length;

		const sessionStart = handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		await Promise.resolve(sessionStart?.({ type: "session_start" }, { cwd: process.cwd(), hasUI: false }));

		expect(refreshCount).toBe(refreshBaseline);
		expect(setActiveToolsCalls).toHaveLength(setActiveToolsBaseline);
	});

	it("recomputes global tool availability on visible session_start", async () => {
		const { pi, handlers } = makePiStub();
		let refreshCount = 0;

		initAgentsMenu(pi, {
			refresh: () => {
				refreshCount += 1;
			},
		});

		const sessionStart = handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		await Promise.resolve(sessionStart?.({ type: "session_start" }, { cwd: process.cwd(), hasUI: true }));

		expect(refreshCount).toBe(1);
	});
});
