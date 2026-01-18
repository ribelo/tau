import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { computeEffectiveConfig, ensureUserDefaults, getProjectSettingsPath, persistUserConfigPatch } from "../src/config.js";

const tmpBase = path.join(os.tmpdir(), `tau-sandbox-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tmpHome = path.join(tmpBase, "home");
const tmpWorkspace = path.join(tmpBase, "workspace");

process.env.TAU_SANDBOX_USER_SETTINGS_PATH = path.join(tmpHome, ".pi", "agent", "settings.json");

function writeJson(p: string, v: any) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf-8");
}

function readJson(p: string): any {
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("sandbox config", () => {
	beforeEach(() => {
		fs.rmSync(tmpBase, { recursive: true, force: true });
		fs.mkdirSync(tmpHome, { recursive: true });
		fs.mkdirSync(tmpWorkspace, { recursive: true });
	});

	it("writes defaults to user settings when missing", () => {
		ensureUserDefaults();
		const p = process.env.TAU_SANDBOX_USER_SETTINGS_PATH!;
		const saved = readJson(p);
		expect(saved.sandbox).toEqual({
			filesystemMode: "workspace-write",
			networkMode: "deny",
			networkAllowlist: [],
			approvalPolicy: "on-failure",
			approvalTimeoutSeconds: 60,
		});
	});

	it("precedence: session > project > user", () => {
		ensureUserDefaults();
		persistUserConfigPatch({ filesystemMode: "workspace-write", networkMode: "allow-all" });

		const projectSettingsPath = getProjectSettingsPath(tmpWorkspace);
		writeJson(projectSettingsPath, { sandbox: { filesystemMode: "read-only", networkMode: "allowlist" } });

		const effective = computeEffectiveConfig({
			workspaceRoot: tmpWorkspace,
			sessionOverride: { filesystemMode: "danger-full-access" },
		});

		expect(effective.filesystemMode).toBe("danger-full-access");
		expect(effective.networkMode).toBe("allowlist");
	});
});
