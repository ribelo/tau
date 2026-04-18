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

import type { ExecutionProfile } from "../execution/schema.js";
import { PromptModes } from "../services/prompt-modes.js";
import {
	COMPLETE_MARKER,
	Ralph,
	type RalphCommandBoundary,
	type RalphStopLoopResult,
	type RalphService,
} from "../services/ralph.js";
import { RalphContractValidationError } from "./errors.js";
import { RALPH_TASKS_DIR } from "./paths.js";
import { sanitizeLoopName, type LoopState, type LoopStatus } from "./schema.js";

const INVALID_STATE_HINT =
	"Ralph state is invalid and could not be decoded. Repair or remove invalid files under .pi/loops (or reset with /ralph nuke --yes).";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Verification
- Add commands, outputs, or file paths that prove the work is done

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

const STATUS_ICONS: Record<LoopStatus, string> = {
	active: "▶",
	paused: "⏸",
	completed: "✓",
};

function isMaxIterationsReached(
	loop: Pick<LoopState, "status" | "iteration" | "maxIterations">,
): boolean {
	return (
		loop.status === "paused" && loop.maxIterations > 0 && loop.iteration >= loop.maxIterations
	);
}

function describeLoopStatus(loop: Pick<LoopState, "status" | "iteration" | "maxIterations">): {
	readonly icon: string;
	readonly label: string;
} {
	if (isMaxIterationsReached(loop)) {
		return {
			icon: "⚠",
			label: "max iterations reached",
		};
	}
	return {
		icon: STATUS_ICONS[loop.status],
		label: loop.status,
	};
}

function persistedStateFailureMessage(error: RalphContractValidationError): string {
	return `${INVALID_STATE_HINT} (${error.entity})\nProblem: ${error.reason}`;
}

function handlePersistedStateFailure(
	error: unknown,
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): Option.Option<string> {
	if (!(error instanceof RalphContractValidationError)) {
		return Option.none();
	}
	const knownEntities = [
		"ralph.loop_state",
		"ralph.loop_state.json",
		"ralph.legacy_layout",
		"loops.state",
		"loops.state.json",
	];
	if (!knownEntities.includes(error.entity)) {
		return Option.none();
	}
	const message =
		error.entity === "ralph.legacy_layout" ? error.reason : persistedStateFailureMessage(error);
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
	}
	return Option.some(message);
}

function isManagedRuntimeDisposedError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.message.includes("ManagedRuntime disposed");
	}
	return String(error).includes("ManagedRuntime disposed");
}

function sessionFileFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	return typeof ctx.sessionManager.getSessionFile === "function"
		? ctx.sessionManager.getSessionFile()
		: undefined;
}

function formatLoop(loop: LoopState): string {
	const status = describeLoopStatus(loop);
	const iter =
		loop.maxIterations > 0 ? `${loop.iteration}/${loop.maxIterations}` : `${loop.iteration}`;
	return `${loop.name}: ${status.icon} ${status.label} (iteration ${iter})`;
}

type ArgsParseFailure = {
	readonly ok: false;
	readonly error: string;
};

type RalphStartArgs = {
	readonly name: string;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
};

type RalphStartArgsParseResult =
	| {
			readonly ok: true;
			readonly value: RalphStartArgs;
	  }
	| ArgsParseFailure;

type RalphResumeArgs = {
	readonly name: string;
	readonly maxIterations: Option.Option<number>;
};

type RalphResumeArgsParseResult =
	| {
			readonly ok: true;
			readonly value: RalphResumeArgs;
	  }
	| ArgsParseFailure;

function parseNonNegativeIntegerOption(
	option: string,
	rawValue: string,
): ArgsParseFailure | number {
	const value = Number.parseInt(rawValue, 10);
	if (!Number.isInteger(value) || value < 0) {
		return {
			ok: false,
			error: `${option} expects a non-negative integer, got "${rawValue}"`,
		};
	}
	return value;
}

function parseArgs(argsStr: string): RalphStartArgsParseResult {
	const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const result = {
		name: "",
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.startsWith("--")) {
			const equalsIndex = token.indexOf("=");
			const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
			const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
			const next = tokens[i + 1];
			const rawValue = inlineValue ?? next;
			if (rawValue === undefined) {
				return {
					ok: false,
					error: `missing value for ${option}`,
				};
			}

			if (option === "--max-iterations") {
				const parsed = parseNonNegativeIntegerOption(option, rawValue);
				if (typeof parsed !== "number") {
					return parsed;
				}
				result.maxIterations = parsed;
			} else if (option === "--items-per-iteration") {
				const parsed = parseNonNegativeIntegerOption(option, rawValue);
				if (typeof parsed !== "number") {
					return parsed;
				}
				result.itemsPerIteration = parsed;
			} else if (option === "--reflect-every") {
				const parsed = parseNonNegativeIntegerOption(option, rawValue);
				if (typeof parsed !== "number") {
					return parsed;
				}
				result.reflectEvery = parsed;
			} else if (option === "--reflect-instructions") {
				result.reflectInstructions = rawValue.replace(/^"|"$/g, "");
			} else {
				return {
					ok: false,
					error: `unknown option "${option}"`,
				};
			}

			if (inlineValue === undefined) {
				i++;
			}
			continue;
		}

		const positional = token.replace(/^"|"$/g, "");
		if (!result.name) {
			result.name = positional;
		} else {
			return {
				ok: false,
				error: `unexpected extra argument "${positional}"`,
			};
		}
	}

	return {
		ok: true,
		value: result,
	};
}

function parseResumeArgs(argsStr: string): RalphResumeArgsParseResult {
	const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const result: {
		name: string;
		maxIterations: Option.Option<number>;
	} = {
		name: "",
		maxIterations: Option.none(),
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.startsWith("--")) {
			const equalsIndex = token.indexOf("=");
			const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
			const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
			const next = tokens[i + 1];
			const rawValue = inlineValue ?? next;
			if (rawValue === undefined) {
				return {
					ok: false,
					error: `missing value for ${option}`,
				};
			}

			if (option !== "--max-iterations") {
				return {
					ok: false,
					error: `unknown option "${option}"`,
				};
			}

			const parsed = parseNonNegativeIntegerOption(option, rawValue);
			if (typeof parsed !== "number") {
				return parsed;
			}
			result.maxIterations = Option.some(parsed);

			if (inlineValue === undefined) {
				i++;
			}
			continue;
		}

		const positional = token.replace(/^"|"$/g, "");
		if (!result.name) {
			result.name = positional;
		} else {
			return {
				ok: false,
				error: `unexpected extra argument "${positional}"`,
			};
		}
	}

	if (!result.name) {
		return {
			ok: false,
			error: "missing loop name",
		};
	}

	return {
		ok: true,
		value: result,
	};
}

function stripSurroundingQuotes(value: string): string {
	return value.replace(/^"|"$/g, "");
}

function formatCommandArgument(value: string): string {
	return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

const BACKLOG_ID_PATTERN =
	/^[a-z][a-z0-9]*-(?=[a-z0-9]{3,8}(?:\.\d+){0,3}$)(?=[a-z0-9]*\d)[a-z0-9]{3,8}(?:\.\d+){0,3}$/;

type ResolvedLoopTarget = {
	readonly loopName: string;
	readonly taskStem: string;
	readonly taskFile: string;
	readonly recommendedStartTarget: string;
	readonly isPath: boolean;
};

type CreateTarget =
	| {
			readonly kind: "path";
			readonly input: string;
			readonly resolved: ResolvedLoopTarget;
	  }
	| {
			readonly kind: "backlog";
			readonly input: string;
			readonly resolved: ResolvedLoopTarget;
	  }
	| {
			readonly kind: "request";
			readonly input: string;
	  };

function resolveLoopTarget(target: string): ResolvedLoopTarget {
	const trimmed = stripSurroundingQuotes(target.trim());
	const isPath = trimmed.includes("/") || trimmed.includes("\\") || trimmed.endsWith(".md");
	const sourceLoopName = isPath ? path.basename(trimmed, path.extname(trimmed)) : trimmed;
	const loopName = sanitizeLoopName(sourceLoopName);
	const taskStem = sourceLoopName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
	const taskFile = isPath ? trimmed : path.join(RALPH_TASKS_DIR, `${taskStem}.md`);
	return {
		loopName,
		taskStem,
		taskFile,
		recommendedStartTarget: formatCommandArgument(isPath ? taskFile : trimmed),
		isPath,
	};
}

function classifyCreateTarget(target: string): CreateTarget {
	const input = stripSurroundingQuotes(target.trim());
	const resolved = resolveLoopTarget(input);
	if (resolved.isPath) {
		return { kind: "path", input, resolved };
	}
	if (BACKLOG_ID_PATTERN.test(input)) {
		return { kind: "backlog", input, resolved };
	}
	return { kind: "request", input };
}

function createPromptStructureLines(): ReadonlyArray<string> {
	return [
		"Use this structure:",
		"- Title and brief summary",
		"- Goals",
		"- Checklist with discrete, verifiable items",
		"- Verification with commands, files, or outputs to capture",
		"- Notes for assumptions, decisions, and progress",
	];
}

function buildCreatePrompt(target: string): string {
	const createTarget = classifyCreateTarget(target);
	const structureLines = createPromptStructureLines();

	if (createTarget.kind === "request") {
		return [
			"Create a Ralph task file for this request:",
			`\`${createTarget.input}\``,
			"",
			"Pick the best short name for the loop and task file.",
			"Use a concise lowercase hyphenated name that fits naturally in `/ralph start <name>`.",
			"Do not mirror the full request text into the file name.",
			"Write the task file at `.pi/loops/tasks/<chosen-name>.md` using apply_patch.",
			"Do not start the loop. Only create or update the task markdown file.",
			"",
			...structureLines,
			"",
			"If this request clearly maps to a backlog item, inspect it first with `backlog show <id>` and synthesize the task from that issue.",
			"Do not update backlog state.",
			"",
			"After writing the file, tell me the chosen name, the path, and recommend starting with `/ralph start <chosen-name>`.",
		].join("\n");
	}

	return [
		`Create a Ralph task file for \`${createTarget.input}\`.`,
		"",
		`Write the task file at \`${createTarget.resolved.taskFile}\` using apply_patch.`,
		"Do not start the loop. Only create or update the task markdown file.",
		"",
		...structureLines,
		"",
		"If the target corresponds to a backlog item, inspect it first with `backlog show <id>` and synthesize the task from that issue.",
		"Do not update backlog state.",
		"Example backlog flow: `/ralph create foo-31z` should inspect `backlog show foo-31z` and write `.pi/loops/tasks/foo-31z.md`.",
		"",
		`After writing the file, tell me the path and recommend starting with \`/ralph start ${createTarget.resolved.recommendedStartTarget}\`.`,
	].join("\n");
}

const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph create <request|path|backlog-id>  Ask the current model to draft a task file
  /ralph start <name|path> [options]  Start a new loop
  /ralph pause                        Pause current loop
  /ralph stop                         End active loop (idle only)
  /ralph resume <name> [options]      Resume a paused loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all Ralph loop data under .pi/loops

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50). On resume, raise the cap in place.

To pause: press ESC or run /ralph pause
To stop: press ESC to interrupt, then run /ralph stop when idle

Examples:
  /ralph create "refactor auth retry flow"
  /ralph create foo-31z
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10
  /ralph resume review --max-iterations 100`;

type RalphUiContext = Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">;

export default function initRalph(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, Ralph | PromptModes>) => Promise<A>,
): void {
	const withRalph = <A, E>(
		f: (service: RalphService) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* Ralph;
				return yield* f(service);
			}),
		);

	const withPromptModes = <A, E>(
		f: (service: PromptModes) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* PromptModes;
				return yield* f(service);
			}),
		);

	const listLoops = (cwd: string, archived = false): Promise<ReadonlyArray<LoopState>> =>
		withRalph((ralph) => ralph.listLoops(cwd, archived));

	const captureCurrentExecutionProfile = (
		ctx: Pick<ExtensionContext, "model" | "sessionManager">,
	): Promise<ExecutionProfile | null> =>
		withPromptModes((promptModes) => promptModes.captureCurrentExecutionProfile(ctx));

	const commandBoundaryFromContext = (ctx: ExtensionCommandContext): RalphCommandBoundary => ({
		cwd: ctx.cwd,
		getSessionFile: () => sessionFileFromContext(ctx),
		switchSession: (targetSessionFile) =>
			Effect.tryPromise(() => ctx.switchSession(targetSessionFile)).pipe(
				Effect.catch(() => Effect.succeed({ cancelled: true })),
			),
		newSession: (options) =>
			Effect.tryPromise(() => ctx.newSession({ parentSession: options.parentSession })).pipe(
				Effect.catch(() => Effect.succeed({ cancelled: true })),
			),
		applyExecutionProfile: (profile) =>
			Effect.promise(() =>
				withPromptModes((promptModes) =>
					promptModes
						.applyExecutionProfile(profile, ctx, {
							notifyOnSuccess: false,
							persist: false,
							ephemeral: true,
						})
						.pipe(
							Effect.map((result) =>
								result.applied
									? { applied: true as const }
									: { applied: false as const, reason: result.reason },
							),
						),
				),
			),
		sendFollowUp: (prompt) =>
			Effect.sync(() => {
				pi.sendUserMessage(prompt, {
					deliverAs: "followUp",
				});
			}),
	});

	const updateUI = async (cwd: string, ctx: RalphUiContext): Promise<void> => {
		if (!ctx.hasUI) {
			return;
		}
		if (typeof ctx.ui.setStatus !== "function" || typeof ctx.ui.setWidget !== "function") {
			return;
		}

		const hasDir = await withRalph((ralph) => ralph.existsRalphDirectory(cwd));
		if (!hasDir) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const state = await withRalph((ralph) =>
			ralph
				.resolveLoopForUi(cwd, sessionFileFromContext(ctx))
				.pipe(Effect.map(Option.getOrUndefined)),
		);

		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const status = describeLoopStatus(state);

		ctx.ui.setStatus(
			"ralph",
			theme.fg("accent", `🔄 ${state.name} (${state.iteration}${maxStr})`),
		);

		const lines = [
			theme.fg("accent", theme.bold("Ralph Wiggum")),
			theme.fg("muted", `Loop: ${state.name}`),
			theme.fg("dim", `Status: ${status.icon} ${status.label}`),
			theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
			theme.fg("dim", `Task: ${state.taskFile}`),
		];

		if (state.reflectEvery > 0) {
			const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
			lines.push(theme.fg("dim", `Next reflection in: ${next} iterations`));
		}

		lines.push("");
		lines.push(theme.fg("warning", "ESC pauses the assistant"));
		lines.push(theme.fg("warning", "Run /ralph pause to keep the loop resumable"));
		lines.push(theme.fg("warning", "Run /ralph stop to end the loop"));
		ctx.ui.setWidget("ralph", lines);
	};

	const runLoop = async (ctx: ExtensionCommandContext, loopName: string): Promise<void> => {
		const result = await withRalph((ralph) =>
			ralph.runLoop(commandBoundaryFromContext(ctx), loopName),
		);
		if (Option.isSome(result.message) && ctx.hasUI) {
			try {
				ctx.ui.notify(result.message.value, "info");
			} catch (error) {
				if (!isManagedRuntimeDisposedError(error)) {
					throw error;
				}
			}
		}
		if (Option.isSome(result.banner)) {
			pi.sendUserMessage(result.banner.value);
		}
		try {
			await updateUI(ctx.cwd, ctx);
		} catch (error) {
			if (!isManagedRuntimeDisposedError(error)) {
				throw error;
			}
		}
	};

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			try {
				const [cmd] = args.trim().split(/\s+/);
				const rest = cmd ? args.slice(args.indexOf(cmd) + cmd.length).trim() : "";

				switch (cmd) {
					case "create": {
						const target = stripSurroundingQuotes(rest.trim());
						if (!target) {
							ctx.ui.notify(
								"Usage: /ralph create <request|path|backlog-id>",
								"warning",
							);
							return;
						}

						const createTarget = classifyCreateTarget(target);
						pi.sendUserMessage(buildCreatePrompt(target));
						if (createTarget.kind === "request") {
							ctx.ui.notify(
								"Asked the current model to draft a Ralph task file and choose a short name",
								"info",
							);
							return;
						}
						ctx.ui.notify(
							`Asked the current model to draft ${createTarget.resolved.taskFile}`,
							"info",
						);
						return;
					}

					case "start": {
						const parsed = parseArgs(rest);
						if (!parsed.ok) {
							ctx.ui.notify(
								`Invalid Ralph start arguments: ${parsed.error}`,
								"warning",
							);
							return;
						}
						if (!parsed.value.name) {
							ctx.ui.notify(
								"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
								"warning",
							);
							return;
						}

						const resolved = resolveLoopTarget(parsed.value.name);
						const loopName = resolved.loopName;
						const taskFile = resolved.taskFile;
						const executionProfile = await captureCurrentExecutionProfile(ctx);
						if (executionProfile === null) {
							ctx.ui.notify(
								"Could not capture the current execution profile for this Ralph loop.",
								"error",
							);
							return;
						}

						const controllerSessionFile = sessionFileFromContext(ctx);
						const start = await withRalph((ralph) =>
							ralph.startLoopState(ctx.cwd, {
								loopName,
								taskFile,
								executionProfile,
								maxIterations: parsed.value.maxIterations,
								itemsPerIteration: parsed.value.itemsPerIteration,
								reflectEvery: parsed.value.reflectEvery,
								reflectInstructions: parsed.value.reflectInstructions,
								controllerSessionFile:
									controllerSessionFile === undefined
										? Option.none()
										: Option.some(controllerSessionFile),
								defaultTaskTemplate: DEFAULT_TEMPLATE,
							}),
						);

						if (start.status === "already_active") {
							ctx.ui.notify(
								`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`,
								"warning",
							);
							return;
						}

						if (start.status === "missing_controller_session") {
							ctx.ui.notify(
								"Loop requires a persisted session file (interactive session).",
								"error",
							);
							return;
						}

						if (start.createdTask) {
							ctx.ui.notify(`Created task file: ${start.taskFile}`, "info");
						}
						await updateUI(ctx.cwd, ctx);
						ctx.ui.notify(
							`Started loop "${start.loopName}" (max ${start.maxIterations} iterations)`,
							"info",
						);
						await runLoop(ctx, start.loopName);
						return;
					}

					case "pause": {
						const paused = await withRalph((ralph) => ralph.pauseCurrentLoop(ctx.cwd));
						if (paused.status === "no_active_loop") {
							ctx.ui.notify("No active Ralph loop", "warning");
							return;
						}
						if (paused.status === "paused") {
							await updateUI(ctx.cwd, ctx);
							ctx.ui.notify(
								`Paused Ralph loop: ${paused.loopName} (iteration ${paused.iteration})`,
								"info",
							);
						}
						return;
					}

					case "stop": {
						if (!ctx.isIdle()) {
							ctx.ui.notify(
								"Agent is busy. Press ESC to interrupt, then run /ralph stop.",
								"warning",
							);
							return;
						}

						const sessionFile = sessionFileFromContext(ctx);
						let scopedLoop = await withRalph((ralph) =>
							ralph
								.findLoopBySessionFile(ctx.cwd, sessionFile)
								.pipe(Effect.map(Option.getOrUndefined)),
						);
						if (!scopedLoop) {
							const loops = await listLoops(ctx.cwd);
							const pausedLoops = loops.filter((loop) => loop.status === "paused");
							const activeLoops = loops.filter((loop) => loop.status === "active");
							if (activeLoops.length === 0) {
								scopedLoop = pausedLoops.length === 1 ? pausedLoops[0] : undefined;
							}
						}

						let stopped: RalphStopLoopResult;
						if (scopedLoop?.status === "paused") {
							await withRalph((ralph) =>
								ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFile),
							);
							const resumeMaxIterations =
								scopedLoop.maxIterations > 0 &&
								scopedLoop.iteration >= scopedLoop.maxIterations
									? Option.some(scopedLoop.iteration + 1)
									: Option.none<number>();
							const resumed = await withRalph((ralph) =>
								ralph.resumeLoopState(ctx.cwd, {
									loopName: scopedLoop.name,
									maxIterations: resumeMaxIterations,
								}),
							);
							stopped =
								resumed.status === "resumed"
									? await withRalph((ralph) => ralph.stopActiveLoop(ctx.cwd))
									: { status: "no_active_loop" as const };
						} else if (scopedLoop?.status === "active") {
							await withRalph((ralph) =>
								ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFile),
							);
							stopped = await withRalph((ralph) => ralph.stopActiveLoop(ctx.cwd));
						} else {
							stopped = await withRalph((ralph) => ralph.stopActiveLoop(ctx.cwd));
						}
						if (stopped.status === "no_active_loop") {
							ctx.ui.notify("No active Ralph loop", "warning");
							return;
						}

						if (stopped.status === "not_active") {
							ctx.ui.notify(`Loop "${stopped.loopName}" is not active`, "warning");
							return;
						}

						await updateUI(ctx.cwd, ctx);
						ctx.ui.notify(
							`Stopped Ralph loop: ${stopped.loopName} (iteration ${stopped.iteration})`,
							"info",
						);
						return;
					}

					case "resume": {
						const parsed = parseResumeArgs(rest);
						if (!parsed.ok) {
							if (parsed.error === "missing loop name") {
								ctx.ui.notify(
									"Usage: /ralph resume <name> [--max-iterations N]",
									"warning",
								);
								return;
							}
							ctx.ui.notify(
								`Invalid Ralph resume arguments: ${parsed.error}`,
								"warning",
							);
							return;
						}

						const loopName = parsed.value.name;
						const resumed = await withRalph((ralph) =>
							ralph.resumeLoopState(ctx.cwd, {
								loopName,
								maxIterations: parsed.value.maxIterations,
							}),
						);
						if (resumed.status === "not_found") {
							ctx.ui.notify(`Loop "${loopName}" not found`, "error");
							return;
						}
						if (resumed.status === "completed") {
							ctx.ui.notify(
								`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`,
								"warning",
							);
							return;
						}
						if (resumed.status === "max_iterations_too_low") {
							ctx.ui.notify(
								`Loop "${loopName}" is at iteration ${resumed.iteration}. --max-iterations must be greater than ${resumed.iteration} (got ${resumed.requestedMaxIterations}).`,
								"warning",
							);
							return;
						}
						if (resumed.status === "max_iterations_reached") {
							ctx.ui.notify(
								`Loop "${loopName}" reached max iterations (${resumed.iteration}/${resumed.maxIterations}). Resume with /ralph resume ${loopName} --max-iterations ${resumed.iteration + 1} (or higher).`,
								"warning",
							);
							await updateUI(ctx.cwd, ctx);
							return;
						}

						await updateUI(ctx.cwd, ctx);
						ctx.ui.notify(`Resuming: ${loopName}`, "info");
						await runLoop(ctx, loopName);
						return;
					}

					case "status": {
						const loops = await listLoops(ctx.cwd);
						if (loops.length === 0) {
							ctx.ui.notify("No Ralph loops found.", "info");
							return;
						}
						ctx.ui.notify(
							`Ralph loops:\n${loops.map((loop) => formatLoop(loop)).join("\n")}`,
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
						const cancelled = await withRalph((ralph) =>
							ralph.cancelLoop(ctx.cwd, loopName),
						);
						if (cancelled.status === "not_found") {
							ctx.ui.notify(`Loop "${loopName}" not found`, "error");
							return;
						}
						ctx.ui.notify(`Cancelled: ${loopName}`, "info");
						await updateUI(ctx.cwd, ctx);
						return;
					}

					case "archive": {
						const loopName = rest.trim();
						if (!loopName) {
							ctx.ui.notify("Usage: /ralph archive <name>", "warning");
							return;
						}

						const archived = await withRalph((ralph) =>
							ralph.archiveLoopByName(ctx.cwd, loopName),
						);
						if (archived.status === "not_found") {
							ctx.ui.notify(`Loop "${loopName}" not found`, "error");
							return;
						}
						if (archived.status === "active_loop") {
							ctx.ui.notify(
								"Cannot archive active loop. Pause or stop it first.",
								"warning",
							);
							return;
						}

						ctx.ui.notify(`Archived: ${loopName}`, "info");
						await updateUI(ctx.cwd, ctx);
						return;
					}

					case "clean": {
						const all = rest.trim() === "--all";
						const cleaned = await withRalph((ralph) =>
							ralph.cleanCompletedLoops(ctx.cwd, all),
						);
						if (cleaned.cleanedLoops.length === 0) {
							ctx.ui.notify("No completed loops to clean", "info");
							return;
						}

						const suffix = all ? " (all files)" : " (state only)";
						ctx.ui.notify(
							`Cleaned ${cleaned.cleanedLoops.length} loop(s)${suffix}:\n${cleaned.cleanedLoops.map((loopName) => `  • ${loopName}`).join("\n")}`,
							"info",
						);
						await updateUI(ctx.cwd, ctx);
						return;
					}

					case "list": {
						const archived = rest.trim() === "--archived";
						const loops = await listLoops(ctx.cwd, archived);
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
							`${label}:\n${loops.map((loop) => formatLoop(loop)).join("\n")}`,
							"info",
						);
						return;
					}

					case "nuke": {
						const force = rest.trim() === "--yes";
						const warning =
							"This deletes all Ralph state, task, and archive files under .pi/loops. Non-Ralph loop data is kept.";

						const runNuke = async () => {
							const result = await withRalph((ralph) => ralph.nukeLoops(ctx.cwd));
							if (!result.removed) {
								if (ctx.hasUI) {
									ctx.ui.notify(
										"No Ralph loop data found under .pi/loops.",
										"info",
									);
								}
								return;
							}

							if (ctx.hasUI) {
								ctx.ui.notify("Removed Ralph loop data under .pi/loops.", "info");
							}
							await updateUI(ctx.cwd, ctx);
						};

						if (!force) {
							if (ctx.hasUI) {
								void ctx.ui
									.confirm("Delete all Ralph loop files?", warning)
									.then((confirmed) => {
										if (confirmed) {
											void runNuke();
										}
									});
							} else {
								ctx.ui.notify(
									`Run /ralph nuke --yes to confirm. ${warning}`,
									"warning",
								);
							}
							return;
						}

						if (ctx.hasUI) {
							ctx.ui.notify(warning, "warning");
						}
						await runNuke();
						return;
					}

					default: {
						ctx.ui.notify(HELP, "info");
						return;
					}
				}
			} catch (error) {
				if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
					return;
				}
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "ralph_create",
		label: "Create Ralph Loop",
		description:
			"Create a Ralph task file for a long-running development loop. Fresh-session Ralph loops are started by the /ralph command.",
		promptSnippet:
			"Create a persistent multi-iteration Ralph loop task. The fresh-session controller is started by /ralph start.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"This tool prepares the Ralph task file; the fresh-session controller is command-owned and starts via /ralph start.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({ description: "Task in markdown with goals and checklist" }),
			itemsPerIteration: Type.Optional(
				Type.Number({ description: "Suggest N items per turn (0 = no limit)" }),
			),
			reflectEvery: Type.Optional(Type.Number({ description: "Reflect every N iterations" })),
			maxIterations: Type.Optional(
				Type.Number({
					description: "Max iterations (default: 50)",
					default: 50,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionCommandContext) {
			try {
				const loopName = sanitizeLoopName(params.name);
				const result = await withRalph((ralph) =>
					ralph.prepareLoopTask(ctx.cwd, {
						loopName,
						taskContent: params.taskContent,
					}),
				);

				if (result.status === "already_active") {
					return {
						content: [{ type: "text", text: `Loop "${loopName}" already active.` }],
						details: {},
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Created Ralph task file at ${result.taskFile}. Fresh-session Ralph is command-owned; start it with /ralph start ${loopName} --max-iterations ${params.maxIterations ?? 50}${params.itemsPerIteration !== undefined ? ` --items-per-iteration ${params.itemsPerIteration}` : ""}${params.reflectEvery !== undefined ? ` --reflect-every ${params.reflectEvery}` : ""}.`,
						},
					],
					details: { taskFile: result.taskFile, loopName },
					isError: true,
				};
			} catch (error) {
				const message = handlePersistedStateFailure(error, ctx);
				if (Option.isSome(message)) {
					return {
						content: [{ type: "text", text: message.value }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			const name = (args.name as string) || "";
			const max = (args.maxIterations as number) || 50;
			let text = theme.fg("toolTitle", theme.bold("ralph_create "));
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
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const result = await withRalph((ralph) =>
					ralph.recordIterationDone(ctx.cwd, sessionFileFromContext(ctx)),
				);
				await updateUI(ctx.cwd, ctx);
				return {
					content: [{ type: "text", text: result.text }],
					details: {},
				};
			} catch (error) {
				const message = handlePersistedStateFailure(error, ctx);
				if (Option.isSome(message)) {
					return {
						content: [{ type: "text", text: message.value }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ralph_done")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const sessionFile = sessionFileFromContext(ctx);
			const state = await withRalph((ralph) =>
				ralph
					.findLoopBySessionFile(ctx.cwd, sessionFile)
					.pipe(Effect.map(Option.getOrUndefined)),
			);
			if (!state || state.status !== "active") {
				return;
			}
			if (Option.getOrUndefined(state.activeIterationSessionFile) !== sessionFile) {
				return;
			}

			const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
			let instructions = `You are in a Ralph loop working on: ${state.taskFile}\n`;
			if (state.itemsPerIteration > 0) {
				instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
			}
			instructions += "- Update the task file as you progress\n";
			instructions += `- When FULLY COMPLETE: ${COMPLETE_MARKER}\n`;
			instructions += "- Otherwise, call ralph_done tool to proceed to next iteration";

			return {
				systemPrompt:
					event.systemPrompt +
					`\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
			};
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		try {
			const result = await withRalph((ralph) =>
				ralph.handleAgentEnd(ctx.cwd, sessionFileFromContext(ctx), event),
			);
			if (Option.isSome(result.banner)) {
				pi.sendUserMessage(result.banner.value);
				await updateUI(ctx.cwd, ctx);
			}
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await withRalph((ralph) =>
				ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFileFromContext(ctx)),
			);
			const active = (await listLoops(ctx.cwd)).filter((loop) => loop.status === "active");
			if (active.length > 0 && ctx.hasUI) {
				const lines = active.map(
					(loop) =>
						`  • ${loop.name} (iteration ${loop.iteration}${loop.maxIterations > 0 ? `/${loop.maxIterations}` : ""})`,
				);
				ctx.ui.notify(
					`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`,
					"info",
				);
			}
			await updateUI(ctx.cwd, ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		try {
			await withRalph((ralph) =>
				ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFileFromContext(ctx)),
			);
			await updateUI(ctx.cwd, ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await withRalph((ralph) =>
				ralph.persistOwnedLoopOnShutdown(ctx.cwd, sessionFileFromContext(ctx)),
			);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});
}
