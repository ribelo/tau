import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ForgeState } from "../src/forge/types.js";
import {
	loadState,
	saveState,
	deleteForge,
	listForges,
	findActiveForge,
	forgeDir,
	statePath,
} from "../src/forge/state.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-forge-"));
	tempDirs.push(dir);
	return dir;
}

function makeState(overrides: Partial<ForgeState> = {}): ForgeState {
	return {
		taskId: "tau-test1",
		phase: "implementing",
		cycle: 1,
		status: "active",
		reviewer: {},
		startedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("forge state", () => {
	it("round-trips through JSON", () => {
		const cwd = makeTmp();
		const state = makeState();
		saveState(cwd, state);
		const loaded = loadState(cwd, state.taskId);
		expect(loaded).toEqual(state);
	});

	it("returns undefined for missing state", () => {
		const cwd = makeTmp();
		expect(loadState(cwd, "tau-nonexistent")).toBeUndefined();
	});

	it("saves to correct path", () => {
		const cwd = makeTmp();
		const state = makeState({ taskId: "tau-abc" });
		saveState(cwd, state);
		const fp = statePath(cwd, "tau-abc");
		expect(fs.existsSync(fp)).toBe(true);
		expect(fp).toBe(path.join(forgeDir(cwd), "tau-abc", "state.json"));
	});

	it("overwrites on save", () => {
		const cwd = makeTmp();
		const state = makeState();
		saveState(cwd, state);
		state.cycle = 5;
		saveState(cwd, state);
		const loaded = loadState(cwd, state.taskId);
		expect(loaded?.cycle).toBe(5);
	});

	it("deletes forge directory", () => {
		const cwd = makeTmp();
		const state = makeState();
		saveState(cwd, state);
		deleteForge(cwd, state.taskId);
		expect(loadState(cwd, state.taskId)).toBeUndefined();
	});

	it("lists all forges", () => {
		const cwd = makeTmp();
		saveState(cwd, makeState({ taskId: "tau-a" }));
		saveState(cwd, makeState({ taskId: "tau-b", status: "paused" }));
		saveState(cwd, makeState({ taskId: "tau-c", status: "completed" }));
		const all = listForges(cwd);
		expect(all).toHaveLength(3);
		expect(all.map((s) => s.taskId).sort()).toEqual(["tau-a", "tau-b", "tau-c"]);
	});

	it("returns empty list for nonexistent directory", () => {
		const cwd = makeTmp();
		expect(listForges(cwd)).toEqual([]);
	});

	it("finds active forge", () => {
		const cwd = makeTmp();
		saveState(cwd, makeState({ taskId: "tau-paused", status: "paused" }));
		saveState(cwd, makeState({ taskId: "tau-active", status: "active" }));
		const active = findActiveForge(cwd);
		expect(active?.taskId).toBe("tau-active");
	});

	it("returns undefined when no active forge", () => {
		const cwd = makeTmp();
		saveState(cwd, makeState({ taskId: "tau-paused", status: "paused" }));
		expect(findActiveForge(cwd)).toBeUndefined();
	});
});

describe("forge state transitions", () => {
	it("tracks phase: implementing -> reviewing -> implementing", () => {
		const cwd = makeTmp();
		const state = makeState({ phase: "implementing" });
		saveState(cwd, state);

		state.phase = "reviewing";
		saveState(cwd, state);
		expect(loadState(cwd, state.taskId)?.phase).toBe("reviewing");

		state.phase = "implementing";
		state.cycle++;
		saveState(cwd, state);
		const reloaded = loadState(cwd, state.taskId);
		expect(reloaded?.phase).toBe("implementing");
		expect(reloaded?.cycle).toBe(2);
	});

	it("tracks status: active -> paused -> active -> completed", () => {
		const cwd = makeTmp();
		const state = makeState({ status: "active" });
		saveState(cwd, state);

		state.status = "paused";
		saveState(cwd, state);
		expect(loadState(cwd, state.taskId)?.status).toBe("paused");

		state.status = "active";
		saveState(cwd, state);
		expect(loadState(cwd, state.taskId)?.status).toBe("active");

		state.status = "completed";
		state.completedAt = new Date().toISOString();
		saveState(cwd, state);
		const final = loadState(cwd, state.taskId);
		expect(final?.status).toBe("completed");
		expect(final?.completedAt).toBeDefined();
	});

	it("stores lastFeedback on reject", () => {
		const cwd = makeTmp();
		const state = makeState();
		saveState(cwd, state);

		state.lastFeedback = "Fix the validation logic in auth.ts";
		state.cycle++;
		state.phase = "implementing";
		saveState(cwd, state);

		const loaded = loadState(cwd, state.taskId);
		expect(loaded?.lastFeedback).toBe("Fix the validation logic in auth.ts");
		expect(loaded?.cycle).toBe(2);
	});

	it("stores reviewer model config", () => {
		const cwd = makeTmp();
		const state = makeState({ reviewer: { model: "claude-4-opus" } });
		saveState(cwd, state);

		const loaded = loadState(cwd, state.taskId);
		expect(loaded?.reviewer.model).toBe("claude-4-opus");
	});

	it("stores last implementer message and structured review result", () => {
		const cwd = makeTmp();
		const state = makeState({
			lastImplementerMessage: "Implemented the fix.",
			lastReview: {
				findings: [
					{
						title: "Guard undefined auth header",
						body: "The code still assumes the header exists.",
						confidence_score: 0.88,
						priority: 1,
						code_location: {
							absolute_file_path: "/tmp/auth.ts",
							line_range: { start: 3, end: 5 },
						},
					},
				],
				overall_correctness: "patch is incorrect",
				overall_explanation: "A blocking issue remains.",
				overall_confidence_score: 0.9,
			},
		});
		saveState(cwd, state);

		const loaded = loadState(cwd, state.taskId);
		expect(loaded?.lastImplementerMessage).toBe("Implemented the fix.");
		expect(loaded?.lastReview?.findings[0]?.title).toBe("Guard undefined auth header");
	});
});
