import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { loadDreamConfig } from "../src/dream/config-loader.js";

async function withTempWorkspace(
	fn: (paths: {
		readonly cwd: string;
		readonly userSettingsPath: string;
	}) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "tau-dream-config-"));
	const cwd = path.join(root, "workspace");
	const userSettingsPath = path.join(root, "home", ".pi", "agent", "settings.json");

	await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
	await fs.writeFile(path.join(cwd, ".git"), "", "utf8");

	const previous = process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
	process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = userSettingsPath;

	try {
		await fn({ cwd, userSettingsPath });
	} finally {
		if (previous === undefined) {
			delete process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
		} else {
			process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = previous;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

describe("loadDreamConfig", () => {
	it("loads explicit dream settings with project override", async () => {
		await withTempWorkspace(async ({ cwd, userSettingsPath }) => {
			await writeJson(userSettingsPath, {
				tau: {
					dream: {
						enabled: true,
						manual: { enabled: true },
						auto: {
							enabled: true,
							minHoursSinceLastRun: 24,
							minSessionsSinceLastRun: 3,
							scanThrottleMinutes: 10,
						},
						subagent: {
							model: "openai/gpt-5.4-mini",
							thinking: "medium",
							maxTurns: 12,
						},
					},
				},
			});

			await writeJson(path.join(cwd, ".pi", "settings.json"), {
				tau: {
					dream: {
						manual: { enabled: false },
						auto: { scanThrottleMinutes: 15 },
						subagent: { maxTurns: 10 },
					},
				},
			});

			const config = await Effect.runPromise(loadDreamConfig(cwd));

			expect(config.enabled).toBe(true);
			expect(config.manual.enabled).toBe(false);
			expect(config.auto.enabled).toBe(true);
			expect(config.auto.minHoursSinceLastRun).toBe(24);
			expect(config.auto.minSessionsSinceLastRun).toBe(3);
			expect(config.auto.scanThrottleMinutes).toBe(15);
			expect(config.subagent.model).toBe("openai/gpt-5.4-mini");
			expect(config.subagent.thinking).toBe("medium");
			expect(config.subagent.maxTurns).toBe(10);
		});
	});

	it("fails when tau.dream is not configured", async () => {
		await withTempWorkspace(async ({ cwd, userSettingsPath }) => {
			await writeJson(userSettingsPath, {});
			await writeJson(path.join(cwd, ".pi", "settings.json"), {});

			await expect(Effect.runPromise(loadDreamConfig(cwd))).rejects.toMatchObject({
				_tag: "DreamConfigDecodeError",
				reason: expect.stringContaining("tau.dream.enabled"),
			});
		});
	});

	it("fails on negative thresholds", async () => {
		await withTempWorkspace(async ({ cwd, userSettingsPath }) => {
			await writeJson(userSettingsPath, {
				tau: {
					dream: {
						enabled: true,
						manual: { enabled: true },
						auto: {
							enabled: false,
							minHoursSinceLastRun: 24,
							minSessionsSinceLastRun: 5,
							scanThrottleMinutes: 10,
						},
						subagent: {
							model: "openai/gpt-5.4-mini",
							thinking: "high",
							maxTurns: 8,
						},
					},
				},
			});
			await writeJson(path.join(cwd, ".pi", "settings.json"), {
				tau: {
					dream: {
						auto: {
							minHoursSinceLastRun: -1,
						},
					},
				},
			});

			await expect(Effect.runPromise(loadDreamConfig(cwd))).rejects.toMatchObject({
				_tag: "DreamConfigInvalidThreshold",
				field: "auto.minHoursSinceLastRun",
				value: -1,
			});
		});
	});

	it("fails on invalid subagent.maxTurns values", async () => {
		await withTempWorkspace(async ({ cwd, userSettingsPath }) => {
			await writeJson(userSettingsPath, {
				tau: {
					dream: {
						enabled: true,
						manual: { enabled: true },
						auto: {
							enabled: false,
							minHoursSinceLastRun: 24,
							minSessionsSinceLastRun: 5,
							scanThrottleMinutes: 10,
						},
						subagent: {
							model: "openai/gpt-5.4-mini",
							thinking: "high",
							maxTurns: 8,
						},
					},
				},
			});
			await writeJson(path.join(cwd, ".pi", "settings.json"), {
				tau: {
					dream: {
						subagent: {
							maxTurns: 0,
						},
					},
				},
			});

			await expect(Effect.runPromise(loadDreamConfig(cwd))).rejects.toMatchObject({
				_tag: "DreamConfigInvalidThreshold",
				field: "subagent.maxTurns",
				value: 0,
			});
		});
	});
});
