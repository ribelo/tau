import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import initAgentsMenu from "../src/agents-menu/index.js";

type EventContext = {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui?: {
		readonly notify: (message: string, level: "info" | "error") => void;
	};
};

type EventHandler = (event: unknown, ctx: EventContext) => unknown;

type RegisteredCommand = {
	readonly name: string;
	readonly description: string;
};

function writeInvalidAgentSettings(tempHome: string): void {
	const agentDir = path.join(tempHome, ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
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
}

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
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("registers /agents command", () => {
		const { pi, commands } = makePiStub();

		initAgentsMenu(pi, {
			refresh: () => undefined,
		});

		const agentsCmd = commands.find((c) => c.name === "agents");
		expect(agentsCmd).toBeDefined();
		expect(typeof agentsCmd!.description).toBe("string");
		expect(agentsCmd!.description.length).toBeGreaterThan(0);
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

		await Promise.resolve(
			sessionStart?.({ type: "session_start" }, { cwd: process.cwd(), hasUI: false }),
		);

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

		await Promise.resolve(
			sessionStart?.({ type: "session_start" }, { cwd: process.cwd(), hasUI: true }),
		);

		expect(refreshCount).toBe(1);
	});

	it("fails closed on visible session_start when registry loading fails", async () => {
		const { pi, handlers, setActiveToolsCalls } = makePiStub();
		const refreshedDescriptions: string[] = [];

		initAgentsMenu(pi, {
			refresh: (description) => {
				refreshedDescriptions.push(description);
			},
		});

		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-agents-menu-home-"));
		writeInvalidAgentSettings(tempHome);
		vi.stubEnv("HOME", tempHome);

		try {
			const notify = vi.fn();
			const sessionStart = handlers.get("session_start")?.[0];
			expect(sessionStart).toBeTypeOf("function");

			await Promise.resolve(
				sessionStart?.(
					{ type: "session_start" },
					{
						cwd: process.cwd(),
						hasUI: true,
						ui: {
							notify,
						},
					},
				),
			);

			expect(setActiveToolsCalls.at(-1)).toEqual([]);
			expect(refreshedDescriptions).toHaveLength(1);
			const refreshedDescription = refreshedDescriptions[0];
			if (refreshedDescription === undefined) {
				throw new Error("expected refreshed description");
			}
			expect(refreshedDescription.length).toBeGreaterThan(0);
			expect(notify).toHaveBeenCalledTimes(1);
			const firstCall = notify.mock.calls[0];
			if (firstCall === undefined) {
				throw new Error("expected notify call");
			}
			const [message, level] = firstCall;
			expect(level).toBe("error");
			expect(message).toContain("imaginary_tool");
			expect(message).not.toContain("\n");
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("fails closed on headless session_switch when registry loading fails", async () => {
		const { pi, handlers, setActiveToolsCalls } = makePiStub();
		const refreshedDescriptions: string[] = [];

		initAgentsMenu(pi, {
			refresh: (description) => {
				refreshedDescriptions.push(description);
			},
		});

		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-agents-menu-headless-home-"));
		writeInvalidAgentSettings(tempHome);
		vi.stubEnv("HOME", tempHome);

		try {
			const sessionSwitch = handlers.get("session_switch")?.[0];
			expect(sessionSwitch).toBeTypeOf("function");

			await Promise.resolve(
				sessionSwitch?.({ type: "session_switch" }, { cwd: process.cwd(), hasUI: false }),
			);

			expect(setActiveToolsCalls.at(-1)).toEqual([]);
			expect(refreshedDescriptions).toHaveLength(1);
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
