import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	AgentSelectionStore,
	getAgentSettingsPath,
} from "../src/agents-menu/state.js";

async function makeWorkspace(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "tau-agents-settings-"));
}

describe("agent selection settings", () => {
	const cleanup = new Set<string>();

	afterEach(async () => {
		await Promise.all(
			Array.from(cleanup, (dir) => fs.rm(dir, { recursive: true, force: true })),
		);
		cleanup.clear();
	});

	it("loads saved enabled agents from project settings", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify({ tau: { agents: { enabled: ["finder"] } } }, null, 2),
			"utf8",
		);

		const store = new AgentSelectionStore();
		store.activate(workspace, ["deep", "finder", "smart"]);

		expect(store.isDisabledForCwd(workspace, "finder")).toBe(false);
		expect(store.isDisabledForCwd(workspace, "deep")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "smart")).toBe(true);
	});

	it("keeps unsaved agent changes across reactivation for the same project", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);

		const store = new AgentSelectionStore();
		store.activate(workspace, ["finder", "smart"]);
		store.setEnabledForCwd(workspace, "smart", false);

		store.activate(workspace, ["finder", "smart"]);

		expect(store.isDisabledForCwd(workspace, "smart")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "finder")).toBe(false);
	});

	it("tracks disabled agents per project instead of using the last activated project", async () => {
		const workspaceA = await makeWorkspace();
		const workspaceB = await makeWorkspace();
		cleanup.add(workspaceA);
		cleanup.add(workspaceB);

		const store = new AgentSelectionStore();
		store.activate(workspaceA, ["finder", "smart"]);
		store.setEnabledForCwd(workspaceA, "smart", false);

		store.activate(workspaceB, ["finder", "smart"]);

		expect(store.isDisabledForCwd(workspaceA, "smart")).toBe(true);
		expect(store.isDisabledForCwd(workspaceB, "smart")).toBe(false);
	});

	it("persists enabled agents into project settings without overwriting unrelated settings", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify(
				{
					other: { keep: true },
					tau: { dream: { enabled: true } },
				},
				null,
				2,
			),
			"utf8",
		);

		const store = new AgentSelectionStore();
		store.activate(workspace, ["finder", "smart"]);
		store.setEnabledForCwd(workspace, "smart", false);
		store.persistForCwd(workspace, ["finder", "smart"]);

		const raw = await fs.readFile(settingsPath, "utf8");
		expect(JSON.parse(raw)).toEqual({
			other: { keep: true },
			tau: {
				agents: { enabled: ["finder"] },
				dream: { enabled: true },
			},
		});
	});

	it("tracks dirty state per project independently", async () => {
		const workspaceA = await makeWorkspace();
		const workspaceB = await makeWorkspace();
		cleanup.add(workspaceA);
		cleanup.add(workspaceB);

		const store = new AgentSelectionStore();
		store.activate(workspaceA, ["finder", "smart"]);
		store.activate(workspaceB, ["finder", "smart"]);
		store.setEnabledForCwd(workspaceA, "smart", false);

		expect(store.isDirtyForCwd(workspaceA)).toBe(true);
		expect(store.isDirtyForCwd(workspaceB)).toBe(false);
	});
});
