import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { computeEffectiveConfig, ensureUserDefaults } from "../src/sandbox/config.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-sandbox-config-"));
}

describe("sandbox-config", () => {
	afterEach(() => {
		delete process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
	});

	it("fails fast on malformed user settings and does not overwrite file", () => {
		const dir = makeTempDir();
		const settingsPath = path.join(dir, "settings.json");
		const malformed = "{ this is not valid json";
		fs.writeFileSync(settingsPath, malformed, "utf8");
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		expect(() => ensureUserDefaults()).toThrow(/Invalid settings JSON/);
		expect(fs.readFileSync(settingsPath, "utf8")).toBe(malformed);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("rejects invalid filesystemMode in settings", () => {
		const workspaceRoot = makeTempDir();
		const settingsPath = path.join(workspaceRoot, "user-settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				tau: {
					sandbox: {
						filesystemMode: "invalid-mode",
					},
				},
			}),
			"utf8",
		);
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		expect(() => computeEffectiveConfig({ workspaceRoot })).toThrow(/Invalid sandbox config/);

		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	});
});
