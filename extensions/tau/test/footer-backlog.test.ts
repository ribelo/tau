import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createIssue, setIssueStatus } from "../src/backlog/events.js";
import { countInProgressIssues, readFooterBacklogInProgressCount } from "../src/services/footer.js";

async function withTempWorkspace<A>(fn: (workspaceRoot: string) => Promise<A>): Promise<A> {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tau-footer-backlog-"));
	try {
		await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
		return await fn(workspaceRoot);
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	}
}

describe("footer backlog hygiene", () => {
	it("counts in-progress issues from backlog state", () => {
		expect(
			countInProgressIssues([
				{ id: "tau-1", title: "one", status: "in_progress" },
				{ id: "tau-2", title: "two", status: "open" },
				{ id: "tau-3", title: "three", status: "closed" },
			]),
		).toBe(1);
	});

	it("resolves the nearest workspace root and reads backlog cache state", async () => {
		await withTempWorkspace(async (workspaceRoot) => {
			const first = await createIssue(workspaceRoot, { title: "Alpha", actor: "test" });
			await createIssue(workspaceRoot, { title: "Beta", actor: "test" });
			await setIssueStatus(workspaceRoot, {
				issueId: first.id,
				actor: "test",
				status: "in_progress",
			});

			const nested = path.join(workspaceRoot, "packages", "tau", "src");
			await fs.mkdir(nested, { recursive: true });

			expect(await readFooterBacklogInProgressCount(nested)).toBe(1);
		});
	});
});
