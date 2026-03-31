import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { Effect, Option } from "effect";
import type { AgentRuntimeBridgeService } from "../agent/runtime.js";
import { AgentControl } from "../agent/services.js";

const RALPH_DIR = ".pi/ralph";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

// Runtime bridge for subagent checks (set during init)
let agentRuntime: AgentRuntimeBridgeService | undefined;
let agentEndResolve: ((event: AgentEndEvent) => void) | undefined;

/** Check if any subagent is active (pending or running). */
async function hasActiveSubagents(): Promise<boolean> {
	if (!agentRuntime) return false;
	try {
		const agents = await agentRuntime.runPromise(
			Effect.gen(function* () {
				const control = yield* AgentControl;
				return yield* control.list;
			}),
		);
		return agents.some(
			(a) => a.status.state === "pending" || a.status.state === "running",
		);
	} catch {
		return false;
	}
}

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Notes
(Update this as you work)
`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

type LoopStatus = "active" | "paused" | "completed";

interface LoopState {
	readonly name: string;
	readonly taskFile: string;
	iteration: number;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
	status: LoopStatus;
	readonly startedAt: string;
	completedAt: Option.Option<string>;
	lastReflectionAt: number;
	// Fresh-session controller fields (ported from ralphi)
	controllerSessionFile: Option.Option<string>;
	activeIterationSessionFile: Option.Option<string>;
	advanceRequestedAt: Option.Option<string>;
	awaitingFinalize: boolean;
}

const STATUS_ICONS: Record<LoopStatus, string> = {
	active: "▶",
	paused: "⏸",
	completed: "✓",
};

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
}

function waitForAgentEnd(): Promise<AgentEndEvent> {
	return new Promise<AgentEndEvent>((resolve) => {
		agentEndResolve = resolve;
	});
}

function extractLastAssistantText(event: AgentEndEvent): string {
	const lastAssistant = [...event.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (!lastAssistant || !Array.isArray(lastAssistant.content)) return "";
	return lastAssistant.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function decodeStringOption(value: unknown): Option.Option<string> {
	if (typeof value === "string") return Option.some(value);
	if (typeof value !== "object" || value === null || !("_tag" in value)) {
		return Option.none();
	}
	if (value._tag === "Some" && "value" in value && typeof value.value === "string") {
		return Option.some(value.value);
	}
	if (value._tag === "None") return Option.none();
	return Option.none();
}

function normalizeLoopState(raw: unknown): LoopState | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const name = record["name"];
	const taskFile = record["taskFile"];
	const iteration = record["iteration"];
	const maxIterations = record["maxIterations"];
	const itemsPerIteration = record["itemsPerIteration"];
	const reflectEvery = record["reflectEvery"];
	const reflectInstructions = record["reflectInstructions"];
	const startedAt = record["startedAt"];
	const lastReflectionAt = record["lastReflectionAt"];
	if (
		typeof name !== "string" ||
		typeof taskFile !== "string" ||
		typeof iteration !== "number" ||
		typeof maxIterations !== "number" ||
		typeof itemsPerIteration !== "number" ||
		typeof reflectEvery !== "number" ||
		typeof reflectInstructions !== "string" ||
		typeof startedAt !== "string" ||
		typeof lastReflectionAt !== "number"
	) {
		return undefined;
	}
	const statusValue = record["status"];
	const status: LoopStatus =
		statusValue === "active" || statusValue === "paused" || statusValue === "completed"
			? statusValue
			: record["active"] === true
				? "active"
				: "paused";
	return {
		name,
		taskFile,
		iteration,
		maxIterations,
		itemsPerIteration,
		reflectEvery,
		reflectInstructions,
		status,
		startedAt,
		completedAt: decodeStringOption(record["completedAt"]),
		lastReflectionAt,
		controllerSessionFile: decodeStringOption(record["controllerSessionFile"]),
		activeIterationSessionFile: decodeStringOption(record["activeIterationSessionFile"]),
		advanceRequestedAt: decodeStringOption(record["advanceRequestedAt"]),
		awaitingFinalize: record["awaitingFinalize"] === true,
	};
}

function optionContains(option: Option.Option<string>, value: string | undefined): boolean {
	if (value === undefined) return false;
	return Option.match(option, {
		onNone: () => false,
		onSome: (optionValue) => optionValue === value,
	});
}

function loopOwnsSessionFile(loop: LoopState, sessionFile: string | undefined): boolean {
	return (
		optionContains(loop.controllerSessionFile, sessionFile) ||
		optionContains(loop.activeIterationSessionFile, sessionFile)
	);
}

function findLoopBySessionFile(cwd: string, sessionFile: string | undefined): LoopState | undefined {
	if (sessionFile === undefined) return undefined;
	return listLoops(cwd).find(
		(loop) => loop.status === "active" && loopOwnsSessionFile(loop, sessionFile),
	);
}

function sessionFileFromContext(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	return typeof ctx.sessionManager.getSessionFile === "function"
		? ctx.sessionManager.getSessionFile()
		: undefined;
}

function ensureDir(filePath: string): void {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function tryRead(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

function tryDelete(filePath: string): void {
	try {
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
	} catch {
		// noop
	}
}

function tryRemoveDir(dirPath: string): boolean {
	try {
		if (fs.existsSync(dirPath)) {
			fs.rmSync(dirPath, { recursive: true, force: true });
		}
		return true;
	} catch {
		return false;
	}
}

function ralphDir(cwd: string): string {
	return path.resolve(cwd, RALPH_DIR);
}

function archiveDir(cwd: string): string {
	return path.join(ralphDir(cwd), "archive");
}

function getPath(cwd: string, name: string, ext: string, archived = false): string {
	const dir = archived ? archiveDir(cwd) : ralphDir(cwd);
	return path.join(dir, `${sanitize(name)}${ext}`);
}

function loadState(cwd: string, name: string, archived = false): LoopState | undefined {
	const content = tryRead(getPath(cwd, name, ".state.json", archived));
	if (!content) return undefined;
	return normalizeLoopState(JSON.parse(content));
}

function saveState(cwd: string, state: LoopState, archived = false): void {
	const filePath = getPath(cwd, state.name, ".state.json", archived);
	ensureDir(filePath);
	fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

function listLoops(cwd: string, archived = false): LoopState[] {
	const dir = archived ? archiveDir(cwd) : ralphDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".state.json"))
		.map((f) => {
			const content = tryRead(path.join(dir, f));
			if (!content) return undefined;
			return normalizeLoopState(JSON.parse(content));
		})
		.filter((s): s is LoopState => s !== undefined);
}

function formatLoop(l: LoopState): string {
	const status = `${STATUS_ICONS[l.status]} ${l.status}`;
	const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
	return `${l.name}: ${status} (iteration ${iter})`;
}

function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
	const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
	const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

	const parts = [header, ""];
	if (isReflection) parts.push(state.reflectInstructions, "\n---\n");

	parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
	parts.push(`\n## Instructions\n`);
	parts.push(
		"User controls: ESC pauses the assistant. Run /ralph-stop when idle to stop the loop.\n",
	);
	parts.push(
		`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
	);

	if (state.itemsPerIteration > 0) {
		parts.push(
			`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`,
		);
		parts.push(
			`1. Work on the next ~${state.itemsPerIteration} items from your checklist`,
		);
	} else {
		parts.push(`1. Continue working on the task`);
	}
	parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
	parts.push(`3. When FULLY COMPLETE, respond with: ${COMPLETE_MARKER}`);
	parts.push(`4. Otherwise, call the ralph_done tool to proceed to next iteration`);

	return parts.join("\n");
}

function parseArgs(argsStr: string): {
	name: string;
	maxIterations: number;
	itemsPerIteration: number;
	reflectEvery: number;
	reflectInstructions: string;
} {
	const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const result = {
		name: "",
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
	};

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		const next = tokens[i + 1];
		if (tok === "--max-iterations" && next) {
			result.maxIterations = parseInt(next, 10) || 0;
			i++;
		} else if (tok === "--items-per-iteration" && next) {
			result.itemsPerIteration = parseInt(next, 10) || 0;
			i++;
		} else if (tok === "--reflect-every" && next) {
			result.reflectEvery = parseInt(next, 10) || 0;
			i++;
		} else if (tok === "--reflect-instructions" && next) {
			result.reflectInstructions = next.replace(/^"|"$/g, "");
			i++;
		} else if (!tok.startsWith("--")) {
			result.name = tok;
		}
	}
	return result;
}

const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name>                Resume a paused loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all .pi/ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

export const __testing = {
	sanitize,
	normalizeLoopState,
	loopOwnsSessionFile,
};

export default function initRalph(
	pi: ExtensionAPI,
	runtime?: AgentRuntimeBridgeService,
): void {
	agentRuntime = runtime;
	let currentLoop: string | undefined;

	function syncCurrentLoopFromSession(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
		currentLoop = findLoopBySessionFile(ctx.cwd, sessionFileFromContext(ctx))?.name;
	}

	function updateUI(cwd: string, ctx: Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">): void {
		if (!ctx.hasUI) return;
		if (
			typeof ctx.ui.setStatus !== "function" ||
			typeof ctx.ui.setWidget !== "function"
		) {
			return;
		}

		const state =
			(currentLoop ? loadState(cwd, currentLoop) : undefined) ??
			findLoopBySessionFile(cwd, sessionFileFromContext(ctx));
		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}
		currentLoop = state.name;

		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";

		ctx.ui.setStatus(
			"ralph",
			theme.fg("accent", `🔄 ${state.name} (${state.iteration}${maxStr})`),
		);

		const lines = [
			theme.fg("accent", theme.bold("Ralph Wiggum")),
			theme.fg("muted", `Loop: ${state.name}`),
			theme.fg("dim", `Status: ${STATUS_ICONS[state.status]} ${state.status}`),
			theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
			theme.fg("dim", `Task: ${state.taskFile}`),
		];
		if (state.reflectEvery > 0) {
			const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
			lines.push(theme.fg("dim", `Next reflection in: ${next} iterations`));
		}
		lines.push("");
		lines.push(theme.fg("warning", "ESC pauses the assistant"));
		lines.push(theme.fg("warning", "Run /ralph-stop to end the loop"));
		ctx.ui.setWidget("ralph", lines);
	}

	function pauseLoop(
		cwd: string,
		state: LoopState,
		ctx: Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">,
		message?: string,
	): void {
		state.status = "paused";
		saveState(cwd, state);
		currentLoop = undefined;
		updateUI(cwd, ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function stopLoop(
		cwd: string,
		state: LoopState,
		ctx: Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">,
		message?: string,
	): void {
		state.status = "completed";
		state.completedAt = Option.some(new Date().toISOString());
		state.awaitingFinalize = false;
		state.advanceRequestedAt = Option.none();
		saveState(cwd, state);
		currentLoop = undefined;
		updateUI(cwd, ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function completeLoop(
		cwd: string,
		state: LoopState,
		ctx: Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">,
		banner: string,
	): void {
		state.status = "completed";
		state.completedAt = Option.some(new Date().toISOString());
		state.awaitingFinalize = false;
		state.advanceRequestedAt = Option.none();
		saveState(cwd, state);
		currentLoop = undefined;
		updateUI(cwd, ctx);
		pi.sendUserMessage(banner);
	}

	async function finalizePendingIteration(
		ctx: ExtensionCommandContext,
		loopName: string,
	): Promise<"continue" | "blocked" | "stopped"> {
		const state = loadState(ctx.cwd, loopName);
		if (!state || state.status !== "active") return "stopped";
		if (!state.awaitingFinalize) return "continue";
		if (await hasActiveSubagents()) {
			state.activeIterationSessionFile = Option.none();
			pauseLoop(
				ctx.cwd,
				state,
				ctx,
				"Ralph paused: subagents are still active. Complete or close them, then run /ralph resume to continue.",
			);
			return "blocked";
		}
		state.awaitingFinalize = false;
		state.advanceRequestedAt = Option.none();
		saveState(ctx.cwd, state);
		updateUI(ctx.cwd, ctx);
		return "continue";
	}

	async function runSingleIteration(
		ctx: ExtensionCommandContext,
		loopName: string,
	): Promise<"continue" | "blocked" | "stopped"> {
		const state = loadState(ctx.cwd, loopName);
		if (!state || state.status !== "active") return "stopped";

		if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
			completeLoop(
				ctx.cwd,
				state,
				ctx,
				`───────────────────────────────────────────────────────────────────────\n⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached\n───────────────────────────────────────────────────────────────────────`,
			);
			return "stopped";
		}

		const controllerSession = Option.getOrUndefined(state.controllerSessionFile);
		if (controllerSession === undefined) {
			pauseLoop(ctx.cwd, state, ctx, "Ralph loop has no controller session file. Loop paused.");
			return "stopped";
		}

		if (ctx.sessionManager.getSessionFile() !== controllerSession) {
			const switched = await ctx.switchSession(controllerSession);
			if (switched.cancelled) {
				pauseLoop(ctx.cwd, state, ctx, "Could not switch to Ralph controller session.");
				return "stopped";
			}
		}

		if (await hasActiveSubagents()) {
			state.awaitingFinalize = true;
			state.activeIterationSessionFile = Option.none();
			pauseLoop(
				ctx.cwd,
				state,
				ctx,
				"Ralph paused: subagents became active. Complete or close them, then run /ralph resume to continue.",
			);
			return "blocked";
		}

		const child = await ctx.newSession({ parentSession: controllerSession });
		if (child.cancelled) {
			pauseLoop(ctx.cwd, state, ctx, "Creating Ralph iteration session was cancelled.");
			return "stopped";
		}

		const afterNewSession = loadState(ctx.cwd, loopName);
		if (!afterNewSession || afterNewSession.status !== "active") return "stopped";

		afterNewSession.iteration += 1;
		const iterationSessionFile = ctx.sessionManager.getSessionFile();
		afterNewSession.activeIterationSessionFile =
			iterationSessionFile === undefined ? Option.none() : Option.some(iterationSessionFile);
		afterNewSession.awaitingFinalize = false;
		afterNewSession.advanceRequestedAt = Option.none();
		saveState(ctx.cwd, afterNewSession);
		currentLoop = loopName;
		updateUI(ctx.cwd, ctx);

		const content = tryRead(path.resolve(ctx.cwd, afterNewSession.taskFile));
		if (!content) {
			pauseLoop(
				ctx.cwd,
				afterNewSession,
				ctx,
				`Could not read Ralph task file: ${afterNewSession.taskFile}`,
			);
			return "stopped";
		}

		const needsReflection =
			afterNewSession.reflectEvery > 0 &&
			afterNewSession.iteration > 1 &&
			(afterNewSession.iteration - 1) % afterNewSession.reflectEvery === 0;

		const agentDone = waitForAgentEnd();
		pi.sendUserMessage(buildPrompt(afterNewSession, content, needsReflection), {
			deliverAs: "followUp",
		});
		const event = await agentDone;
		const afterTurn = loadState(ctx.cwd, loopName);
		if (!afterTurn || afterTurn.status !== "active") return "stopped";

		const lastAssistantText = extractLastAssistantText(event);
		if (lastAssistantText.includes(COMPLETE_MARKER)) {
			completeLoop(
				ctx.cwd,
				afterTurn,
				ctx,
				`───────────────────────────────────────────────────────────────────────\n✅ RALPH LOOP COMPLETE: ${afterTurn.name} | ${afterTurn.iteration} iterations\n───────────────────────────────────────────────────────────────────────`,
			);
			return "stopped";
		}

		if (!afterTurn.awaitingFinalize) {
			pauseLoop(
				ctx.cwd,
				afterTurn,
				ctx,
				`Iteration ${afterTurn.iteration} ended without ralph_done. Ralph paused. Use /ralph resume ${loopName} to continue.`,
			);
			return "stopped";
		}

		return "continue";
	}

	async function runRalphLoop(ctx: ExtensionCommandContext, loopName: string): Promise<void> {
		while (true) {
			const state = loadState(ctx.cwd, loopName);
			if (!state || state.status !== "active") return;
			currentLoop = loopName;
			updateUI(ctx.cwd, ctx);

			const finalizeResult = await finalizePendingIteration(ctx, loopName);
			if (finalizeResult !== "continue") return;

			const iterationResult = await runSingleIteration(ctx, loopName);
			if (iterationResult !== "continue") return;
		}
	}

	// --- Commands ---

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const rest = cmd ? args.slice(args.indexOf(cmd) + cmd.length).trim() : "";

			switch (cmd) {
				case "start": {
					const parsed = parseArgs(rest);
					if (!parsed.name) {
						ctx.ui.notify(
							"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
							"warning",
						);
						return;
					}

					const isPath = parsed.name.includes("/") || parsed.name.includes("\\");
					const loopName = isPath
						? sanitize(path.basename(parsed.name, path.extname(parsed.name)))
						: parsed.name;
					const taskFile = isPath
						? parsed.name
						: path.join(RALPH_DIR, `${loopName}.md`);

					const existing = loadState(ctx.cwd, loopName);
					if (existing?.status === "active") {
						ctx.ui.notify(
							`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`,
							"warning",
						);
						return;
					}

					const fullPath = path.resolve(ctx.cwd, taskFile);
					if (!fs.existsSync(fullPath)) {
						ensureDir(fullPath);
						fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
						ctx.ui.notify(`Created task file: ${taskFile}`, "info");
					}

					// Store controller session (current session becomes controller)
					const controllerSessionFile = ctx.sessionManager.getSessionFile();
					if (!controllerSessionFile) {
						ctx.ui.notify(
							"Loop requires a persisted session file (interactive session).",
							"error",
						);
						return;
					}

					const state: LoopState = {
						name: loopName,
						taskFile,
						iteration: 0, // Will be incremented to 1 by runRalphLoop
						maxIterations: parsed.maxIterations,
						itemsPerIteration: parsed.itemsPerIteration,
						reflectEvery: parsed.reflectEvery,
						reflectInstructions: parsed.reflectInstructions,
						status: "active",
						startedAt: existing?.startedAt ?? new Date().toISOString(),
						lastReflectionAt: 0,
						completedAt: Option.none(),
						controllerSessionFile: Option.some(controllerSessionFile),
						activeIterationSessionFile: Option.none(),
						advanceRequestedAt: Option.none(),
						awaitingFinalize: false,
					};

					saveState(ctx.cwd, state);
					currentLoop = loopName;
					updateUI(ctx.cwd, ctx);

					ctx.ui.notify(`Started loop "${loopName}" (max ${state.maxIterations} iterations)`, "info");

					// Start the first iteration
					await runRalphLoop(ctx, loopName);
					return;
				}

				case "stop": {
					if (!currentLoop) {
						const active = listLoops(ctx.cwd).find((l) => l.status === "active");
						if (active) {
							pauseLoop(
								ctx.cwd,
								active,
								ctx,
								`Paused Ralph loop: ${active.name} (iteration ${active.iteration})`,
							);
						} else {
							ctx.ui.notify("No active Ralph loop", "warning");
						}
						return;
					}
					const state = loadState(ctx.cwd, currentLoop);
					if (state) {
						pauseLoop(
							ctx.cwd,
							state,
							ctx,
							`Paused Ralph loop: ${currentLoop} (iteration ${state.iteration})`,
						);
					}
					return;
				}

				case "resume": {
					const loopName = rest.trim();
					if (!loopName) {
						ctx.ui.notify("Usage: /ralph resume <name>", "warning");
						return;
					}

					const state = loadState(ctx.cwd, loopName);
					if (!state) {
						ctx.ui.notify(`Loop "${loopName}" not found`, "error");
						return;
					}
					if (state.status === "completed") {
						ctx.ui.notify(
							`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`,
							"warning",
						);
						return;
					}

					if (currentLoop && currentLoop !== loopName) {
						const curr = loadState(ctx.cwd, currentLoop);
						if (curr) pauseLoop(ctx.cwd, curr, ctx);
					}

					// Resume the loop by running the controller
					state.status = "active";
					saveState(ctx.cwd, state);
					currentLoop = loopName;
					updateUI(ctx.cwd, ctx);

					ctx.ui.notify(`Resuming: ${loopName}`, "info");

					// Continue the loop
					await runRalphLoop(ctx, loopName);
					return;
				}

				case "status": {
					const loops = listLoops(ctx.cwd);
					if (loops.length === 0) {
						ctx.ui.notify("No Ralph loops found.", "info");
						return;
					}
					ctx.ui.notify(
						`Ralph loops:\n${loops.map((l) => formatLoop(l)).join("\n")}`,
						"info",
					);
					return;
				}

				case "cancel": {
					const loopName = rest.trim();
					if (!loopName) {
						ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
						return;
					}
					if (!loadState(ctx.cwd, loopName)) {
						ctx.ui.notify(`Loop "${loopName}" not found`, "error");
						return;
					}
					if (currentLoop === loopName) currentLoop = undefined;
					tryDelete(getPath(ctx.cwd, loopName, ".state.json"));
					ctx.ui.notify(`Cancelled: ${loopName}`, "info");
					updateUI(ctx.cwd, ctx);
					return;
				}

				case "archive": {
					const loopName = rest.trim();
					if (!loopName) {
						ctx.ui.notify("Usage: /ralph archive <name>", "warning");
						return;
					}
					const state = loadState(ctx.cwd, loopName);
					if (!state) {
						ctx.ui.notify(`Loop "${loopName}" not found`, "error");
						return;
					}
					if (state.status === "active") {
						ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
						return;
					}

					if (currentLoop === loopName) currentLoop = undefined;

					const srcState = getPath(ctx.cwd, loopName, ".state.json");
					const dstState = getPath(ctx.cwd, loopName, ".state.json", true);
					ensureDir(dstState);
					if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

					const srcTask = path.resolve(ctx.cwd, state.taskFile);
					if (
						srcTask.startsWith(ralphDir(ctx.cwd)) &&
						!srcTask.startsWith(archiveDir(ctx.cwd))
					) {
						const dstTask = getPath(ctx.cwd, loopName, ".md", true);
						if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
					}

					ctx.ui.notify(`Archived: ${loopName}`, "info");
					updateUI(ctx.cwd, ctx);
					return;
				}

				case "clean": {
					const all = rest.trim() === "--all";
					const completed = listLoops(ctx.cwd).filter(
						(l) => l.status === "completed",
					);

					if (completed.length === 0) {
						ctx.ui.notify("No completed loops to clean", "info");
						return;
					}

					for (const loop of completed) {
						tryDelete(getPath(ctx.cwd, loop.name, ".state.json"));
						if (all) tryDelete(getPath(ctx.cwd, loop.name, ".md"));
						if (currentLoop === loop.name) currentLoop = undefined;
					}

					const suffix = all ? " (all files)" : " (state only)";
					ctx.ui.notify(
						`Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`,
						"info",
					);
					updateUI(ctx.cwd, ctx);
					return;
				}

				case "list": {
					const archived = rest.trim() === "--archived";
					const loops = listLoops(ctx.cwd, archived);

					if (loops.length === 0) {
						ctx.ui.notify(
							archived
								? "No archived loops"
								: "No loops found. Use /ralph list --archived for archived.",
							"info",
						);
						return;
					}

					const label = archived ? "Archived loops" : "Ralph loops";
					ctx.ui.notify(
						`${label}:\n${loops.map((l) => formatLoop(l)).join("\n")}`,
						"info",
					);
					return;
				}

				case "nuke": {
					const force = rest.trim() === "--yes";
					const warning =
						"This deletes all .pi/ralph state, task, and archive files. External task files are not removed.";

					const run = () => {
						const dir = ralphDir(ctx.cwd);
						if (!fs.existsSync(dir)) {
							if (ctx.hasUI) ctx.ui.notify("No .pi/ralph directory found.", "info");
							return;
						}

						currentLoop = undefined;
						const ok = tryRemoveDir(dir);
						if (ctx.hasUI) {
							ctx.ui.notify(
								ok
									? "Removed .pi/ralph directory."
									: "Failed to remove .pi/ralph directory.",
								ok ? "info" : "error",
							);
						}
						updateUI(ctx.cwd, ctx);
					};

					if (!force) {
						if (ctx.hasUI) {
							void ctx.ui
								.confirm("Delete all Ralph loop files?", warning)
								.then((confirmed) => {
									if (confirmed) run();
								});
						} else {
							ctx.ui.notify(
								`Run /ralph nuke --yes to confirm. ${warning}`,
								"warning",
							);
						}
						return;
					}

					if (ctx.hasUI) ctx.ui.notify(warning, "warning");
					run();
					return;
				}

				default: {
					ctx.ui.notify(HELP, "info");
					return;
				}
			}
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop (idle only)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Agent is busy. Press ESC to interrupt, then run /ralph-stop.",
						"warning",
					);
				}
				return;
			}

			let state = currentLoop ? loadState(ctx.cwd, currentLoop) : undefined;
			if (!state) {
				const active = listLoops(ctx.cwd).find((l) => l.status === "active");
				if (!active) {
					if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
					return;
				}
				state = active;
			}

			if (state.status !== "active") {
				if (ctx.hasUI)
					ctx.ui.notify(`Loop "${state.name}" is not active`, "warning");
				return;
			}

			stopLoop(
				ctx.cwd,
				state,
				ctx,
				`Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`,
			);
		},
	});

	// --- Tools ---

	pi.registerTool({
		name: "ralph_start",
		label: "Start Ralph Loop",
		description:
			"Create a Ralph task file for a long-running development loop. Fresh-session Ralph loops are started by the /ralph command.",
		promptSnippet:
			"Prepare a persistent multi-iteration Ralph loop task. The fresh-session controller is started by /ralph start.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"This tool prepares the Ralph task file; the fresh-session controller is command-owned and starts via /ralph start.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({
				description: "Task in markdown with goals and checklist",
			}),
			itemsPerIteration: Type.Optional(
				Type.Number({ description: "Suggest N items per turn (0 = no limit)" }),
			),
			reflectEvery: Type.Optional(
				Type.Number({ description: "Reflect every N iterations" }),
			),
			maxIterations: Type.Optional(
				Type.Number({
					description: "Max iterations (default: 50)",
					default: 50,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionCommandContext) {
			const loopName = sanitize(params.name);
			const taskFile = path.join(RALPH_DIR, `${loopName}.md`);

			if (loadState(ctx.cwd, loopName)?.status === "active") {
				return {
					content: [
						{ type: "text", text: `Loop "${loopName}" already active.` },
					],
					details: {},
				};
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			ensureDir(fullPath);
			fs.writeFileSync(fullPath, params.taskContent, "utf-8");

			return {
				content: [
					{
						type: "text",
						text: `Created Ralph task file at ${taskFile}. Fresh-session Ralph is command-owned; start it with /ralph start ${loopName} --max-iterations ${params.maxIterations ?? 50}${params.itemsPerIteration !== undefined ? ` --items-per-iteration ${params.itemsPerIteration}` : ""}${params.reflectEvery !== undefined ? ` --reflect-every ${params.reflectEvery}` : ""}.`,
					},
				],
				details: { taskFile, loopName },
				isError: true,
			};
		},

		renderCall(args, theme) {
			const name = (args.name as string) || "";
			const max = (args.maxIterations as number) || 50;
			let text = theme.fg("toolTitle", theme.bold("ralph_start "));
			text += theme.fg("accent", name);
			text += theme.fg("dim", ` (max ${max})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "ralph_done",
		label: "Ralph Iteration Done",
		description:
			"Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt. Do NOT call this if you've output the completion marker.",
		promptSnippet:
			"Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const scopedLoop =
				findLoopBySessionFile(ctx.cwd, ctx.sessionManager.getSessionFile())?.name ??
				currentLoop;
			if (!scopedLoop) {
				return {
					content: [{ type: "text", text: "No active Ralph loop." }],
					details: {},
				};
			}

			const state = loadState(ctx.cwd, scopedLoop);
			if (!state || state.status !== "active") {
				return {
					content: [{ type: "text", text: "Ralph loop is not active." }],
					details: {},
				};
			}

			// Check for active subagents - block advancement if any are running
			if (await hasActiveSubagents()) {
				state.awaitingFinalize = true;
				state.advanceRequestedAt = Option.some(new Date().toISOString());
				state.activeIterationSessionFile = Option.none();
				state.status = "paused";
				saveState(ctx.cwd, state);
				currentLoop = undefined;
				updateUI(ctx.cwd, ctx);
				return {
					content: [
						{
							type: "text",
							text: "Ralph iteration recorded. Subagents are still active, so advancement is blocked until they finish. Run /ralph resume when they are done.",
						},
					],
					details: {},
				};
			}

			// Record that this iteration is ready to finalize
			state.advanceRequestedAt = Option.some(new Date().toISOString());
			state.awaitingFinalize = true;
			saveState(ctx.cwd, state);
			currentLoop = scopedLoop;

			return {
				content: [
					{
						type: "text",
						text: `Iteration ${state.iteration} complete. Finalize recorded.`,
					},
				],
				details: {},
			};
		},

		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("ralph_done")),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	// --- Event handlers ---

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionFile = sessionFileFromContext(ctx);
		const state = findLoopBySessionFile(ctx.cwd, sessionFile);
		if (!state || state.status !== "active") return;
		if (!optionContains(state.activeIterationSessionFile, sessionFile)) return;

		const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;

		let instructions = `You are in a Ralph loop working on: ${state.taskFile}\n`;
		if (state.itemsPerIteration > 0) {
			instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
		}
		instructions += `- Update the task file as you progress\n`;
		instructions += `- When FULLY COMPLETE: ${COMPLETE_MARKER}\n`;
		instructions += `- Otherwise, call ralph_done tool to proceed to next iteration`;

		return {
			systemPrompt:
				event.systemPrompt +
				`\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const resolve = agentEndResolve;
		agentEndResolve = undefined;
		if (resolve) {
			resolve(event);
			return;
		}

		const sessionFile = sessionFileFromContext(ctx);
		const state = findLoopBySessionFile(ctx.cwd, sessionFile);
		if (!state || state.status !== "active") return;
		if (!optionContains(state.activeIterationSessionFile, sessionFile)) return;

		const text = extractLastAssistantText(event);
		if (!text.includes(COMPLETE_MARKER)) return;

		state.status = "completed";
		state.completedAt = Option.some(new Date().toISOString());
		state.awaitingFinalize = false;
		state.advanceRequestedAt = Option.none();
		saveState(ctx.cwd, state);
		if (currentLoop === state.name) currentLoop = undefined;
		updateUI(ctx.cwd, ctx);
		pi.sendUserMessage(
			`───────────────────────────────────────────────────────────────────────\n✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations\n───────────────────────────────────────────────────────────────────────`,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		syncCurrentLoopFromSession(ctx);
		const active = listLoops(ctx.cwd).filter((l) => l.status === "active");
		if (active.length > 0 && ctx.hasUI) {
			const lines = active.map(
				(l) =>
					`  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`,
			);
			ctx.ui.notify(
				`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`,
				"info",
			);
		}
		updateUI(ctx.cwd, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncCurrentLoopFromSession(ctx);
		updateUI(ctx.cwd, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const scoped = findLoopBySessionFile(ctx.cwd, sessionFileFromContext(ctx));
		const state = scoped ?? (currentLoop ? loadState(ctx.cwd, currentLoop) : undefined);
		if (state) saveState(ctx.cwd, state);
	});
}
