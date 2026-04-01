import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function makePiStub(): ExtensionAPI {
	const base = {
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerFlag: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getThinkingLevel: vi.fn(() => "medium"),
		setThinkingLevel: vi.fn(),
		setModel: vi.fn(async () => true),
		getFlag: vi.fn(),
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
		events: {
			emit: vi.fn(),
			on: vi.fn(() => () => undefined),
		},
	};

	return new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return vi.fn();
		},
	}) as unknown as ExtensionAPI;
}

describe("tau startup validation ordering", () => {
	const originalEmitWarning = process.emitWarning;

	afterEach(() => {
		process.emitWarning = originalEmitWarning;
		delete (globalThis as Record<symbol, boolean | undefined>)[
			Symbol.for("tau.sqlite-warning-filter-installed")
		];
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("starts the runtime before startup validation settles", async () => {
		const startTau = vi.fn((pi: ExtensionAPI) => ({
			fiber: Symbol("fiber"),
			ready: Promise.resolve(),
			pi,
		}));
		let resolveValidation: (() => void) | undefined;
		const validation = new Promise<void>((resolve) => {
			resolveValidation = resolve;
		});
		const validateAgentDefinitionsAtStartup = vi.fn(() => validation);

		vi.doMock("../src/app.js", () => ({ startTau, runTau: vi.fn() }));
		vi.doMock("../src/agent/startup-validation.js", () => ({
			validateAgentDefinitionsAtStartup,
		}));

		const { default: tau } = await import("../src/index.js");
		const pi = makePiStub();

		const result = tau(pi);
		await result;

		expect(result).toBeInstanceOf(Promise);
		expect(validateAgentDefinitionsAtStartup).toHaveBeenCalledTimes(1);
		expect(validateAgentDefinitionsAtStartup).toHaveBeenCalledWith(process.cwd());
		expect(startTau).toHaveBeenCalledTimes(1);
		expect(startTau.mock.calls[0]?.[0]).toBe(pi);

		await result;

		resolveValidation?.();
		await validation;
	});

	it("does not pass a notify handler into startup validation", async () => {
		const startTau = vi.fn((pi: ExtensionAPI) => ({
			fiber: Symbol("fiber"),
			ready: Promise.resolve(),
			pi,
		}));
		const validateAgentDefinitionsAtStartup = vi.fn(async () => undefined);

		vi.doMock("../src/app.js", () => ({ startTau, runTau: vi.fn() }));
		vi.doMock("../src/agent/startup-validation.js", () => ({
			validateAgentDefinitionsAtStartup,
		}));

		const { default: tau } = await import("../src/index.js");
		const pi = makePiStub();

		await tau(pi);

		expect(startTau).toHaveBeenCalledTimes(1);
		expect(validateAgentDefinitionsAtStartup).toHaveBeenCalledWith(process.cwd());
		expect(validateAgentDefinitionsAtStartup.mock.calls[0]).toHaveLength(1);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("suppresses only the node:sqlite experimental warning", async () => {
		const startTau = vi.fn((pi: ExtensionAPI) => ({
			fiber: Symbol("fiber"),
			ready: Promise.resolve(),
			pi,
		}));
		const validateAgentDefinitionsAtStartup = vi.fn(async () => undefined);

		vi.doMock("../src/app.js", () => ({ startTau, runTau: vi.fn() }));
		vi.doMock("../src/agent/startup-validation.js", () => ({
			validateAgentDefinitionsAtStartup,
		}));

		const original = process.emitWarning;
		const forwarded: Array<{ warning: string | Error; args: unknown[] }> = [];
		process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
			forwarded.push({ warning, args });
		}) as typeof process.emitWarning;

		await import("../src/index.js");

		process.emitWarning(
			"SQLite is an experimental feature and might change at any time",
			"ExperimentalWarning",
		);
		expect(forwarded).toHaveLength(0);

		process.emitWarning("Something else", "ExperimentalWarning");
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]).toEqual({
			warning: "Something else",
			args: ["ExperimentalWarning"],
		});

		process.emitWarning = original;
	});
});
