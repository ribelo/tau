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
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("starts the runtime before startup validation settles", async () => {
		const runTau = vi.fn();
		let resolveValidation: (() => void) | undefined;
		const validation = new Promise<void>((resolve) => {
			resolveValidation = resolve;
		});
		const validateAgentDefinitionsAtStartup = vi.fn(() => validation);

		vi.doMock("../src/app.js", () => ({ runTau }));
		vi.doMock("../src/agent/startup-validation.js", () => ({
			validateAgentDefinitionsAtStartup,
		}));

		const { default: tau } = await import("../src/index.js");
		const pi = makePiStub();

		const result = tau(pi);
		await Promise.resolve();

		expect(result).toBeUndefined();
		expect(validateAgentDefinitionsAtStartup).toHaveBeenCalledTimes(1);
		expect(validateAgentDefinitionsAtStartup).toHaveBeenCalledWith(process.cwd());
		expect(runTau).toHaveBeenCalledTimes(1);
		expect(runTau.mock.calls[0]?.[0]).toBe(pi);

		resolveValidation?.();
		await validation;
	});

	it("does not pass a notify handler into startup validation", async () => {
		const runTau = vi.fn();
		const validateAgentDefinitionsAtStartup = vi.fn(async () => undefined);

		vi.doMock("../src/app.js", () => ({ runTau }));
		vi.doMock("../src/agent/startup-validation.js", () => ({
			validateAgentDefinitionsAtStartup,
		}));

		const { default: tau } = await import("../src/index.js");
		const pi = makePiStub();

		tau(pi);

		expect(runTau).toHaveBeenCalledTimes(1);
		expect(validateAgentDefinitionsAtStartup).toHaveBeenCalledWith(process.cwd());
		expect(validateAgentDefinitionsAtStartup.mock.calls[0]).toHaveLength(1);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});
