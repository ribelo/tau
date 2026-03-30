import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const RALPH_DIR = ".ralph";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

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
	completedAt?: string;
	lastReflectionAt: number;
}

const STATUS_ICONS: Record<LoopStatus, string> = {
	active: "▶",
	paused: "⏸",
	completed: "✓",
};

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
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
	const raw = JSON.parse(content) as Record<string, unknown>;
	if (typeof raw["status"] !== "string") {
		raw["status"] = raw["active"] === true ? "active" : "paused";
	}
	return raw as unknown as LoopState;
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
			const raw = JSON.parse(content) as Record<string, unknown>;
			if (typeof raw["status"] !== "string") {
				raw["status"] = raw["active"] === true ? "active" : "paused";
			}
			return raw as unknown as LoopState;
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
		"User controls: ESC pauses the assistant. Send a message to resume. Run /ralph-stop when idle to stop the loop.\n",
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
  /ralph nuke [--yes]                 Delete all .ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

export default function initRalph(pi: ExtensionAPI): void {
	let currentLoop: string | undefined;

	function updateUI(cwd: string, ctx: { hasUI: boolean; ui: import("@mariozechner/pi-coding-agent").ExtensionUIContext }): void {
		if (!ctx.hasUI) return;

		const state = currentLoop ? loadState(cwd, currentLoop) : undefined;
		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

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
		lines.push(theme.fg("warning", "Send a message to resume; /ralph-stop ends the loop"));
		ctx.ui.setWidget("ralph", lines);
	}

	function pauseLoop(
		cwd: string,
		state: LoopState,
		ctx: { hasUI: boolean; ui: import("@mariozechner/pi-coding-agent").ExtensionUIContext },
		message?: string,
	): void {
		state.status = "paused";
		saveState(cwd, state);
		currentLoop = undefined;
		updateUI(cwd, ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function completeLoop(
		cwd: string,
		state: LoopState,
		ctx: { hasUI: boolean; ui: import("@mariozechner/pi-coding-agent").ExtensionUIContext },
		banner: string,
	): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		saveState(cwd, state);
		currentLoop = undefined;
		updateUI(cwd, ctx);
		pi.sendUserMessage(banner);
	}

	function stopLoop(
		cwd: string,
		state: LoopState,
		ctx: { hasUI: boolean; ui: import("@mariozechner/pi-coding-agent").ExtensionUIContext },
		message?: string,
	): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		saveState(cwd, state);
		currentLoop = undefined;
		updateUI(cwd, ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
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

					const state: LoopState = {
						name: loopName,
						taskFile,
						iteration: 1,
						maxIterations: parsed.maxIterations,
						itemsPerIteration: parsed.itemsPerIteration,
						reflectEvery: parsed.reflectEvery,
						reflectInstructions: parsed.reflectInstructions,
						status: "active",
						startedAt: existing?.startedAt ?? new Date().toISOString(),
						lastReflectionAt: 0,
					};

					saveState(ctx.cwd, state);
					currentLoop = loopName;
					updateUI(ctx.cwd, ctx);

					const content = tryRead(fullPath);
					if (!content) {
						ctx.ui.notify(`Could not read task file: ${taskFile}`, "error");
						return;
					}
					pi.sendUserMessage(buildPrompt(state, content, false));
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

					state.status = "active";
					state.iteration++;
					saveState(ctx.cwd, state);
					currentLoop = loopName;
					updateUI(ctx.cwd, ctx);

					ctx.ui.notify(
						`Resumed: ${loopName} (iteration ${state.iteration})`,
						"info",
					);

					const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
					if (!content) {
						ctx.ui.notify(`Could not read task file: ${state.taskFile}`, "error");
						return;
					}

					const needsReflection =
						state.reflectEvery > 0 &&
						state.iteration > 1 &&
						(state.iteration - 1) % state.reflectEvery === 0;
					pi.sendUserMessage(buildPrompt(state, content, needsReflection));
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
						"This deletes all .ralph state, task, and archive files. External task files are not removed.";

					const run = () => {
						const dir = ralphDir(ctx.cwd);
						if (!fs.existsSync(dir)) {
							if (ctx.hasUI) ctx.ui.notify("No .ralph directory found.", "info");
							return;
						}

						currentLoop = undefined;
						const ok = tryRemoveDir(dir);
						if (ctx.hasUI) {
							ctx.ui.notify(
								ok
									? "Removed .ralph directory."
									: "Failed to remove .ralph directory.",
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
			"Start a long-running development loop. Use for complex multi-iteration tasks.",
		promptSnippet:
			"Start a persistent multi-iteration development loop with pacing and reflection controls.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"After starting a loop, continue each finished iteration with ralph_done unless the completion marker has already been emitted.",
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: params.maxIterations ?? 50,
				itemsPerIteration: params.itemsPerIteration ?? 0,
				reflectEvery: params.reflectEvery ?? 0,
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				status: "active",
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
			};

			saveState(ctx.cwd, state);
			currentLoop = loopName;
			updateUI(ctx.cwd, ctx);

			pi.sendUserMessage(buildPrompt(state, params.taskContent, false), {
				deliverAs: "followUp",
			});

			return {
				content: [
					{
						type: "text",
						text: `Started loop "${loopName}" (max ${state.maxIterations} iterations).`,
					},
				],
				details: {},
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
			if (!currentLoop) {
				return {
					content: [{ type: "text", text: "No active Ralph loop." }],
					details: {},
				};
			}

			const state = loadState(ctx.cwd, currentLoop);
			if (!state || state.status !== "active") {
				return {
					content: [{ type: "text", text: "Ralph loop is not active." }],
					details: {},
				};
			}

			if (ctx.hasPendingMessages()) {
				return {
					content: [
						{
							type: "text",
							text: "Pending messages already queued. Skipping ralph_done.",
						},
					],
					details: {},
				};
			}

			state.iteration++;

			if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
				completeLoop(
					ctx.cwd,
					state,
					ctx,
					`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
				);
				return {
					content: [
						{
							type: "text",
							text: "Max iterations reached. Loop stopped.",
						},
					],
					details: {},
				};
			}

			const needsReflection =
				state.reflectEvery > 0 &&
				(state.iteration - 1) % state.reflectEvery === 0;
			if (needsReflection) state.lastReflectionAt = state.iteration;

			saveState(ctx.cwd, state);
			updateUI(ctx.cwd, ctx);

			const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!content) {
				pauseLoop(ctx.cwd, state, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Error: Could not read task file: ${state.taskFile}`,
						},
					],
					details: {},
				};
			}

			pi.sendUserMessage(buildPrompt(state, content, needsReflection), {
				deliverAs: "followUp",
			});

			return {
				content: [
					{
						type: "text",
						text: `Iteration ${state.iteration - 1} complete. Next iteration queued.`,
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
		if (!currentLoop) return;
		const state = loadState(ctx.cwd, currentLoop);
		if (!state || state.status !== "active") return;

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
		if (!currentLoop) return;
		const state = loadState(ctx.cwd, currentLoop);
		if (!state || state.status !== "active") return;

		const lastAssistant = [...event.messages]
			.reverse()
			.find((m) => m.role === "assistant");
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter(
							(c): c is { type: "text"; text: string } => c.type === "text",
						)
						.map((c) => c.text)
						.join("\n")
				: "";

		if (text.includes(COMPLETE_MARKER)) {
			completeLoop(
				ctx.cwd,
				state,
				ctx,
				`───────────────────────────────────────────────────────────────────────
✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
			completeLoop(
				ctx.cwd,
				state,
				ctx,
				`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
			);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
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
		if (currentLoop) updateUI(ctx.cwd, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (currentLoop) {
			const state = loadState(ctx.cwd, currentLoop);
			if (state) saveState(ctx.cwd, state);
		}
	});
}
