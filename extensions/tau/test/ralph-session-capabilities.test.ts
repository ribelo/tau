import { describe, expect, it } from "vitest";

import {
	capturePreRalphActiveTools,
	clearPreRalphActiveToolSnapshots,
	restorePreRalphActiveTools,
} from "../src/ralph/session-capabilities.js";

describe("Ralph session capabilities", () => {
	it("restores the active tools that were present before Ralph applied its contract", () => {
		clearPreRalphActiveToolSnapshots();
		let activeTools = ["read", "bash", "agent", "memory"];
		const runtime = {
			getActiveTools: () => [...activeTools],
			setActiveTools: (next: ReadonlyArray<string>) => {
				activeTools = [...next];
			},
		};

		capturePreRalphActiveTools("/tmp/session.json", runtime);
		activeTools = ["read", "bash", "ralph_continue", "ralph_finish"];

		expect(restorePreRalphActiveTools("/tmp/session.json", runtime)).toBe(true);
		expect(activeTools).toEqual(["read", "bash", "agent", "memory"]);
		expect(restorePreRalphActiveTools("/tmp/session.json", runtime)).toBe(false);
	});

	it("keeps the first pre-Ralph snapshot for a session", () => {
		clearPreRalphActiveToolSnapshots();
		let activeTools = ["read", "bash", "agent"];
		const runtime = {
			getActiveTools: () => [...activeTools],
			setActiveTools: (next: ReadonlyArray<string>) => {
				activeTools = [...next];
			},
		};

		capturePreRalphActiveTools("/tmp/session.json", runtime);
		activeTools = ["read"];
		capturePreRalphActiveTools("/tmp/session.json", runtime);
		activeTools = ["ralph_continue", "ralph_finish"];

		expect(restorePreRalphActiveTools("/tmp/session.json", runtime)).toBe(true);
		expect(activeTools).toEqual(["read", "bash", "agent"]);
	});
});
