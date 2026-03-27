# Tool Nudge System — Implementation Plan

> **Execution:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Periodically remind the agent to use `memory` and `skill_manage` tools when it hasn't used them in a while, similar to hermes-agent's nudging but adapted for pi's extension architecture.

**Architecture:** A single `src/nudge/index.ts` module tracks turn counters, resets on tool use, and injects a transient reminder into the LLM context via the `context` event when thresholds are exceeded. No background agents, no persisted state, no extra turns. The existing static skill nudge in `skill-manage/index.ts` is replaced by a shared baseline in the new module.

**Tech Stack:** TypeScript, pi extension API (`context`, `tool_result`, `turn_end`, `session_start`, `before_agent_start`), no Effect services needed (plain closure state, like `worked-for/index.ts`).

**Reference:** `.reference/hermes-agent/run_agent.py` lines 1414–1548 (review prompts + background agent), lines 5735–5755 (turn counting + nudge trigger).

---

## Design Decisions

### Why `context` event for delivery (not `before_agent_start` or `sendMessage`)

| Mechanism | Fires | Persisted | Extra turn | Mid-run |
|---|---|---|---|---|
| `before_agent_start` | Once per user prompt | In system prompt | No | No |
| `context` | Before every LLM call | No | No | Yes |
| `sendMessage(steer)` | During streaming | Yes (session) | No | Yes |
| `sendMessage(followUp)` | After agent finishes | Yes (session) | Yes | No |

`context` is the sweet spot: fires mid-run (catches long multi-turn tasks), is transient (no session clutter), and costs zero extra turns. We use `before_agent_start` only for a short static baseline awareness line.

### Why one module (not per-tool)

- Single state store, single set of event hooks.
- Combined nudge when both are due (one message, not two).
- Per-tool policies are data, not architecture.

### Counter semantics

- **Memory**: count turns since last `memory` tool use. Threshold: 8 turns.
- **Skills**: count turns since last `skill_manage` tool use. Threshold: 12 turns.
- Both reset on actual tool use (even if `isError`), and on session boundaries.
- Cooldown: after nudging, don't re-nudge for the same tool for N turns (same as threshold).

### Active tool gating

Nudges are suppressed when the tool is not in `pi.getActiveTools()`. Subagents or restricted modes that lack `memory`/`skill_manage` will never see nudges.

---

## Task 1: Create nudge module with state and event wiring

**Objective:** Create `src/nudge/index.ts` with turn tracking, tool-use detection, and counter reset logic.

**Files:**
- Create: `extensions/tau/src/nudge/index.ts`

**Step 1: Create the module skeleton**

```typescript
import type {
	ExtensionAPI,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { prependToLastUserMessage } from "../shared/message-injection.js";

type TrackedTool = "memory" | "skill_manage";

interface NudgePolicy {
	readonly thresholdTurns: number;
	readonly cooldownTurns: number;
	readonly text: string;
}

const POLICIES: Readonly<Record<TrackedTool, NudgePolicy>> = {
	memory: {
		thresholdTurns: 8,
		cooldownTurns: 8,
		text: "You haven't saved to memory recently. If the user shared preferences, corrections, or personal/environment details, save them with `memory` now.",
	},
	skill_manage: {
		thresholdTurns: 12,
		cooldownTurns: 12,
		text: "Consider whether any approach from this session should be saved or updated as a skill with `skill_manage`.",
	},
};

const TRACKED_TOOLS: readonly TrackedTool[] = ["memory", "skill_manage"] as const;

const BASELINE_NUDGE =
	"\n\nWhen you learn durable facts about the user, environment, or project, save them with `memory`. When you discover or fix a reusable workflow, create or patch a skill with `skill_manage`. Skip temporary task state and one-offs.";

function isTrackedTool(name: string): name is TrackedTool {
	return name === "memory" || name === "skill_manage";
}

interface NudgeState {
	turn: number;
	lastUsedTurn: Record<TrackedTool, number>;
	lastNudgedTurn: Record<TrackedTool, number>;
}

function freshState(): NudgeState {
	return {
		turn: 0,
		lastUsedTurn: { memory: 0, skill_manage: 0 },
		lastNudgedTurn: { memory: 0, skill_manage: 0 },
	};
}

export default function initNudge(pi: ExtensionAPI): void {
	let state = freshState();

	// ── Reset on session boundaries ──
	pi.on("session_start", async () => {
		state = freshState();
	});

	pi.on("session_switch", async () => {
		state = freshState();
	});

	// ── Advance turn clock ──
	pi.on("turn_end", async () => {
		state.turn += 1;
	});

	// ── Detect tool use ──
	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (isTrackedTool(event.toolName)) {
			state.lastUsedTurn[event.toolName] = state.turn;
		}
	});

	// ── Static baseline in system prompt ──
	pi.on("before_agent_start", async (event) => {
		const activeTools = pi.getActiveTools();
		const anyTracked = TRACKED_TOOLS.some((t) => activeTools.includes(t));
		if (!anyTracked) return;

		return { systemPrompt: event.systemPrompt + BASELINE_NUDGE };
	});

	// ── Dynamic nudge via context injection ──
	pi.on("context", async (event) => {
		const activeTools = pi.getActiveTools();

		const dueTools = TRACKED_TOOLS.filter((tool) => {
			if (!activeTools.includes(tool)) return false;
			const policy = POLICIES[tool];
			const sinceLast = state.turn - state.lastUsedTurn[tool];
			const sinceNudge = state.turn - state.lastNudgedTurn[tool];
			return sinceLast >= policy.thresholdTurns && sinceNudge >= policy.cooldownTurns;
		});

		if (dueTools.length === 0) return;

		// Mark nudged
		for (const tool of dueTools) {
			state.lastNudgedTurn[tool] = state.turn;
		}

		const lines = dueTools.map((t) => `- ${POLICIES[t].text}`);
		const nudgeText = `[System reminder]\n${lines.join("\n")}\nIgnore if nothing durable or reusable was learned.`;

		return {
			messages: prependToLastUserMessage(event.messages, nudgeText),
		};
	});
}
```

**Step 2: Verify it compiles**

Run from `extensions/tau/`:
```bash
npx tsc --noEmit
```
Expected: no errors related to `src/nudge/index.ts`.

---

## Task 2: Wire nudge module into app.ts

**Objective:** Import and initialize the nudge module from the main extension entrypoint.

**Files:**
- Modify: `extensions/tau/src/app.ts`

**Step 1: Add import**

Add after the existing init imports:
```typescript
import initNudge from "./nudge/index.js";
```

**Step 2: Call initNudge**

Inside the `Effect.sync` block where other `init*` functions are called (around line 146), add:
```typescript
initNudge(pi);
```

Place it near `initMemory` and `initSkillManage` since they're related.

**Step 3: Verify it compiles**

Run from `extensions/tau/`:
```bash
npx tsc --noEmit
```
Expected: no errors.

---

## Task 3: Remove static skill nudge from skill-manage/index.ts

**Objective:** The shared nudge module now owns both the baseline and dynamic nudging. Remove the duplicate static nudge from skill-manage.

**Files:**
- Modify: `extensions/tau/src/skill-manage/index.ts`

**Step 1: Remove the `before_agent_start` handler**

Delete this block from the `initSkillManage` function (around line 245–250):

```typescript
	pi.on("before_agent_start", async (event) => {
		const nudge = "\n\n## Skills (self-improvement)\nAfter completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill with skill_manage so you can reuse it next time.\nWhen using a skill and finding it outdated, incomplete, or wrong, patch it immediately with skill_manage(action='patch') — don't wait to be asked.";
		return { systemPrompt: event.systemPrompt + nudge };
	});
```

**Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

---

## Task 4: Write tests for the nudge module

**Objective:** Test the core nudge logic — counter advancement, tool-use reset, threshold triggering, cooldown, active-tool gating.

**Files:**
- Create: `extensions/tau/test/nudge.test.ts`

**Step 1: Write test file**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ContextEvent,
	ToolResultEvent,
	TurnEndEvent,
	BeforeAgentStartEvent,
} from "@mariozechner/pi-coding-agent";
import initNudge from "../src/nudge/index.js";

type EventHandler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

function makeNudgePiStub(activeTools: string[] = ["memory", "skill_manage"]): {
	readonly pi: ExtensionAPI;
	readonly fire: (event: string, payload: unknown) => Promise<unknown>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();

	const pi = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getActiveTools: () => activeTools,
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getAllTools: () => [],
		getCommands: () => [],
		setActiveTools: () => {},
		setModel: async () => false,
		getThinkingLevel: () => "off" as const,
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: { on: () => () => {}, emit: async () => {} },
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	} as unknown as ExtensionAPI;

	const fire = async (event: string, payload: unknown): Promise<unknown> => {
		const handlers = eventHandlers.get(event) ?? [];
		let result: unknown;
		for (const handler of handlers) {
			result = await handler(payload);
		}
		return result;
	};

	return { pi, fire };
}

function makeContextEvent(): ContextEvent {
	return {
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	} as ContextEvent;
}

function makeToolResultEvent(toolName: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "test-id",
		toolName,
		input: {},
		content: [{ type: "text", text: "ok" }],
		isError: false,
	} as ToolResultEvent;
}

async function advanceTurns(fire: (event: string, payload: unknown) => Promise<unknown>, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await fire("turn_end", { type: "turn_end", turnIndex: i, timestamp: Date.now(), message: { role: "assistant", content: "" } });
	}
}

describe("nudge module", () => {
	it("does not nudge before threshold", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		await advanceTurns(fire, 5);
		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;

		expect(result?.messages).toBeUndefined();
	});

	it("nudges for memory after threshold turns", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		await advanceTurns(fire, 8);
		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;

		expect(result?.messages).toBeDefined();
		const firstContent = (result?.messages?.[0] as { content?: unknown[] })?.content;
		const textItem = firstContent?.find((c: unknown) => (c as { type: string }).type === "text" && (c as { text: string }).text.includes("memory"));
		expect(textItem).toBeDefined();
	});

	it("resets memory counter on tool use", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		await advanceTurns(fire, 7);
		await fire("tool_result", makeToolResultEvent("memory"));
		await advanceTurns(fire, 3);

		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;
		expect(result?.messages).toBeUndefined();
	});

	it("respects cooldown after nudging", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		await advanceTurns(fire, 8);
		await fire("context", makeContextEvent()); // triggers nudge

		await advanceTurns(fire, 3);
		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;
		expect(result?.messages).toBeUndefined();
	});

	it("suppresses nudge when tool is not active", async () => {
		const { pi, fire } = makeNudgePiStub([]); // no active tools
		initNudge(pi);

		await advanceTurns(fire, 15);
		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;
		expect(result?.messages).toBeUndefined();
	});

	it("resets state on session_start", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		await advanceTurns(fire, 8);
		await fire("session_start", { type: "session_start" });
		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;
		expect(result?.messages).toBeUndefined();
	});

	it("appends baseline to system prompt in before_agent_start", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		const result = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "test",
			systemPrompt: "base prompt",
		}) as { systemPrompt?: string } | undefined;

		expect(result?.systemPrompt).toContain("memory");
		expect(result?.systemPrompt).toContain("skill_manage");
	});

	it("omits baseline when no tracked tools are active", async () => {
		const { pi, fire } = makeNudgePiStub(["bash", "read"]);
		initNudge(pi);

		const result = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "test",
			systemPrompt: "base prompt",
		}) as { systemPrompt?: string } | undefined;

		expect(result?.systemPrompt).toBeUndefined();
	});

	it("combines both tool nudges when both are due", async () => {
		const { pi, fire } = makeNudgePiStub();
		initNudge(pi);

		await advanceTurns(fire, 12); // exceeds both thresholds (memory=8, skill=12)
		const result = await fire("context", makeContextEvent()) as { messages?: unknown[] } | undefined;

		expect(result?.messages).toBeDefined();
		const firstContent = (result?.messages?.[0] as { content?: unknown[] })?.content;
		const text = firstContent
			?.filter((c: unknown) => (c as { type: string }).type === "text")
			.map((c: unknown) => (c as { text: string }).text)
			.join("");
		expect(text).toContain("memory");
		expect(text).toContain("skill_manage");
	});
});
```

**Step 2: Run tests**

From `extensions/tau/`:
```bash
npx vitest run test/nudge.test.ts
```
Expected: all tests pass.

---

## Task 5: Run quality gate

**Objective:** Ensure everything compiles, lints, and passes.

**Files:** None (verification only)

**Step 1: Run gate**

From `extensions/tau/`:
```bash
npm run gate
```

Expected: typecheck, lint, and all tests pass.

**Step 2: Commit**

```bash
git add extensions/tau/src/nudge/ extensions/tau/src/app.ts extensions/tau/src/skill-manage/index.ts extensions/tau/test/nudge.test.ts
git commit -m "feat: add periodic tool-use nudging for memory and skill_manage"
```

---

## Summary

| What | Where |
|---|---|
| Nudge module | `extensions/tau/src/nudge/index.ts` |
| Wiring | `extensions/tau/src/app.ts` (add `initNudge(pi)`) |
| Removed duplicate | `extensions/tau/src/skill-manage/index.ts` (delete `before_agent_start` handler) |
| Tests | `extensions/tau/test/nudge.test.ts` |

**Turn budget:** ~8 turns for memory, ~12 for skills. Cooldown prevents spam. Active-tool gating prevents nudges for tools the agent can't call. Delivery via `context` event is transient — no session pollution. The static baseline in `before_agent_start` gives minimal always-on awareness.
