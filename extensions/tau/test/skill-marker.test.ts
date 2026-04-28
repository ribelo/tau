import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillMarkerAutocompleteProvider } from "../src/skill-marker/autocomplete.js";
import initSkillMarker, { createSkillMarkerRuntime } from "../src/skill-marker/index.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function makePiStub(
	skillCommands: Array<{
		readonly name: string;
		readonly description: string;
		readonly path: string;
	}>,
): {
	readonly pi: ExtensionAPI;
	readonly emit: (
		event: string,
		payload: unknown,
		ctxOverrides?: { readonly cwd?: string },
	) => Promise<readonly unknown[]>;
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
		emit: async (event, payload, ctxOverrides) => {
			const handlers = eventHandlers.get(event) ?? [];
			return Promise.all(
				handlers.map((handler) =>
					handler(payload, {
						cwd: ctxOverrides?.cwd ?? process.cwd(),
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
		await Promise.all(
			tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
		);
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
				display: false,
				content: expect.stringContaining(skillPath),
			},
		});
	});

	it("forwards autocomplete options to the wrapped provider when no skill marker matches", async () => {
		const controller = new AbortController();
		const base = {
			getSuggestions: vi.fn(
				async (
					_lines: string[],
					_cursorLine: number,
					_cursorCol: number,
					options?: { readonly signal: AbortSignal; readonly force?: boolean },
				) => {
					expect(options).toEqual({ signal: controller.signal, force: true });
					return {
						items: [{ value: "help", label: "help" }],
						prefix: "/he",
					};
				},
			),
			applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({
				lines,
				cursorLine,
				cursorCol,
			}),
		};

		const provider = new SkillMarkerAutocompleteProvider(
			base as unknown as ConstructorParameters<typeof SkillMarkerAutocompleteProvider>[0],
			() => [],
		);

		const result = await (
			provider as unknown as {
				getSuggestions: (
					lines: string[],
					cursorLine: number,
					cursorCol: number,
					options: { readonly signal: AbortSignal; readonly force?: boolean },
				) => Promise<{
					items: Array<{ value: string; label: string }>;
					prefix: string;
				} | null>;
			}
		).getSuggestions(["/he"], 0, 3, {
			signal: controller.signal,
			force: true,
		});

		expect(base.getSuggestions).toHaveBeenCalledOnce();
		expect(result).toEqual({
			items: [{ value: "help", label: "help" }],
			prefix: "/he",
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

		const [result] = await emit("before_agent_start", {
			prompt: "please use $code-review now",
		});

		expect(result).toEqual({
			message: expect.objectContaining({
				customType: "skill-marker",
				content: expect.stringMatching(/.+/),
			}),
		});
	});

	it("falls back to cwd/skills before skill commands are populated", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-skill-marker-project-"));
		tempDirs.push(tempDir);

		const workspace = path.join(tempDir, "workspace");
		const skillDir = path.join(workspace, "skills", "wirkung");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			skillPath,
			[
				"---",
				"name: wirkung",
				"description: local project skill",
				"---",
				"",
				"# Wirkung",
				"",
				"local workspace instructions",
			].join("\n"),
			"utf8",
		);

		const tempHome = path.join(tempDir, "home");
		await fs.mkdir(path.join(tempHome, ".pi", "agent", "skills"), { recursive: true });
		vi.stubEnv("HOME", tempHome);

		const { pi, emit } = makePiStub([]);
		const runtime = createSkillMarkerRuntime();
		initSkillMarker(pi, runtime);

		const [result] = await emit(
			"before_agent_start",
			{ prompt: "please use $wirkung now" },
			{ cwd: workspace },
		);

		expect(result).toEqual({
			message: expect.objectContaining({
				customType: "skill-marker",
				content: expect.stringContaining("local workspace instructions"),
			}),
		});
	});

	it("prefers cwd/skills over global skills with the same name during fallback discovery", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-skill-marker-precedence-"));
		tempDirs.push(tempDir);

		const workspace = path.join(tempDir, "workspace");
		const localSkillDir = path.join(workspace, "skills", "wirkung");
		const localSkillPath = path.join(localSkillDir, "SKILL.md");
		await fs.mkdir(localSkillDir, { recursive: true });
		await fs.writeFile(
			localSkillPath,
			[
				"---",
				"name: wirkung",
				"description: local project skill",
				"---",
				"",
				"# Wirkung",
				"",
				"local workspace instructions",
			].join("\n"),
			"utf8",
		);

		const tempHome = path.join(tempDir, "home");
		const globalSkillDir = path.join(tempHome, ".pi", "agent", "skills", "wirkung");
		await fs.mkdir(globalSkillDir, { recursive: true });
		await fs.writeFile(
			path.join(globalSkillDir, "SKILL.md"),
			[
				"---",
				"name: wirkung",
				"description: global skill",
				"---",
				"",
				"# Wirkung",
				"",
				"global instructions",
			].join("\n"),
			"utf8",
		);
		vi.stubEnv("HOME", tempHome);

		const { pi, emit } = makePiStub([]);
		const runtime = createSkillMarkerRuntime();
		initSkillMarker(pi, runtime);

		const [result] = await emit(
			"before_agent_start",
			{ prompt: "please use $wirkung now" },
			{ cwd: workspace },
		);

		expect(result).toEqual({
			message: expect.objectContaining({
				customType: "skill-marker",
				content: expect.stringContaining("local workspace instructions"),
			}),
		});
		expect(result).toEqual({
			message: expect.objectContaining({
				content: expect.not.stringContaining("global instructions"),
			}),
		});
	});
});
