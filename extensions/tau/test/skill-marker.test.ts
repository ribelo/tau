import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import initSkillMarker, { createSkillMarkerRuntime } from "../src/skill-marker/index.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function makePiStub(skillCommands: Array<{
	readonly name: string;
	readonly description: string;
	readonly path: string;
}>): {
	readonly pi: ExtensionAPI;
	readonly emit: (event: string, payload: unknown) => Promise<readonly unknown[]>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getCommands: () =>
			skillCommands.map((command) => ({
				name: `skill:${command.name}`,
				description: command.description,
				source: "skill" as const,
				sourceInfo: {
					path: command.path,
					source: "extension:tau",
					scope: "temporary" as const,
					origin: "top-level" as const,
					baseDir: path.dirname(command.path),
				},
			})),
		registerTool: () => undefined,
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	};

	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;

	return {
		pi,
		emit: async (event, payload) => {
			const handlers = eventHandlers.get(event) ?? [];
			return Promise.all(
				handlers.map((handler) =>
					handler(payload, {
						cwd: process.cwd(),
						hasUI: false,
					}),
				),
			);
		},
	};
}

describe("skill-marker", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
	});

	it("loads extension-discovered skills from the active skill command set", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-skill-marker-"));
		tempDirs.push(tempDir);

		const skillDir = path.join(tempDir, "godmode");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			skillPath,
			[
				"---",
				"name: godmode",
				"description: test skill",
				"---",
				"",
				"# Godmode",
				"",
				"marker instructions",
			].join("\n"),
			"utf8",
		);

		const { pi, emit } = makePiStub([
			{
				name: "godmode",
				description: "test skill",
				path: skillPath,
			},
		]);
		const runtime = createSkillMarkerRuntime();
		initSkillMarker(pi, runtime);

		const [result] = await emit("before_agent_start", { prompt: "please use $godmode now" });

		expect(result).toEqual({
			message: {
				customType: "skill-marker",
				content: expect.stringContaining("marker instructions"),
				display: false,
			},
		});
		expect(result).toEqual({
			message: expect.objectContaining({
				content: expect.stringContaining(skillPath),
			}),
		});
	});

	it("falls back to tau bundled skills before skill commands are populated", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-skill-marker-home-"));
		tempDirs.push(tempDir);

		const tempHome = path.join(tempDir, "home");
		await fs.mkdir(path.join(tempHome, ".pi", "agent", "skills"), { recursive: true });
		vi.stubEnv("HOME", tempHome);

		const { pi, emit } = makePiStub([]);
		const runtime = createSkillMarkerRuntime();
		initSkillMarker(pi, runtime);

		const [result] = await emit("before_agent_start", { prompt: "please use $godmode now" });

		expect(result).toEqual({
			message: expect.objectContaining({
				customType: "skill-marker",
				content: expect.stringContaining("G0DM0D3 Jailbreaking Skill"),
			}),
		});
	});
});
