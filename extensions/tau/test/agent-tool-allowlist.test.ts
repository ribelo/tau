import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { applyAgentToolAllowlist } from "../src/agent/tool-allowlist.js";
import { AgentError } from "../src/agent/services.js";
import type { AgentDefinition } from "../src/agent/types.js";

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-tool-allowlist-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const agentToolDefinition: ToolDefinition = {
	name: "agent",
	label: "agent",
	description: "Manage worker agents",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "ok" }],
			details: { ok: true },
		};
	},
};

const submitResultToolDefinition: ToolDefinition = {
	name: "submit_result",
	label: "submit_result",
	description: "Submit structured result",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "submitted" }],
			details: { ok: true },
		};
	},
};

function buildDefinition(tools: readonly string[] | undefined): AgentDefinition {
	return {
		name: "test-agent",
		description: "test agent",
		models: [{ model: "inherit", thinking: "inherit" }],
		...(tools !== undefined ? { tools } : {}),
		sandbox: { preset: "read-only" },
		systemPrompt: "Test prompt",
	};
}

describe("agent tool allowlist", () => {
	it("activates exactly the configured tool set", async () => {
		await withTempDir(async (cwd) => {
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
				authStorage: AuthStorage.create(),
				modelRegistry: new ModelRegistry(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, submitResultToolDefinition],
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(session, buildDefinition(["read", "agent"]), undefined),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "agent"]);
		});
	});

	it("auto-enables submit_result when structured output is required", async () => {
		await withTempDir(async (cwd) => {
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
				authStorage: AuthStorage.create(),
				modelRegistry: new ModelRegistry(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, submitResultToolDefinition],
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(["read"]),
					Type.Object({ ok: Type.Boolean() }),
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "submit_result"]);
		});
	});

	it("fails fast on unknown tools", async () => {
		await withTempDir(async (cwd) => {
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
				authStorage: AuthStorage.create(),
				modelRegistry: new ModelRegistry(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition],
			});

			await expect(
				Effect.runPromise(
					applyAgentToolAllowlist(
						session,
						buildDefinition(["read", "not-real"]),
						undefined,
					),
				),
			).rejects.toThrowError(AgentError);
			await expect(
				Effect.runPromise(
					applyAgentToolAllowlist(
						session,
						buildDefinition(["read", "not-real"]),
						undefined,
					),
				),
			).rejects.toThrow(/Invalid tools for agent "test-agent": not-real/);
		});
	});
});
