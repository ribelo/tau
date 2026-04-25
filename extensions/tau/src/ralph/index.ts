import * as path from "node:path";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Text,
	SettingsList,
	SelectList,
	Container,
	Spacer,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	type SettingItem,
} from "@mariozechner/pi-tui";
import { Effect, Option } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";
import { PromptModes } from "../services/prompt-modes.js";
import {
	Ralph,
	type RalphCommandBoundary,
	type RalphStopLoopResult,
	type RalphService,
} from "../services/ralph.js";
import { RalphContractValidationError } from "./errors.js";
import { RALPH_TASKS_DIR } from "./paths.js";
import { sanitizeLoopName, type LoopState, type LoopStatus } from "./schema.js";
import { setToolEnabled } from "../shared/tool-activation.js";
import { loadPersistedState, TAU_PERSISTED_STATE_TYPE } from "../shared/state.js";
import { captureCapabilityContract, effectiveToolNames } from "./resolver.js";
import type { RalphCapabilityContract } from "./contract.js";
import type { RalphConfigMutation } from "./config-service.js";
import { AgentRegistry } from "../agent/agent-registry.js";
import { resolveEnabledAgentsForSessionAuthoritative } from "../agents-menu/index.js";
import {
	computeEffectiveConfig,
	type ResolvedSandboxConfig,
	type SandboxConfig,
	type SandboxPreset,
} from "../sandbox/config.js";
import { discoverWorkspaceRoot } from "../sandbox/workspace-root.js";

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

type RalphPromptDispatcher = (prompt: string) => void;

type RalphExecutionProfileApplyResult = {
	readonly applied: boolean;
	readonly reason?: string;
};

type RalphExecutionProfileApplier = (
	profile: ExecutionProfile,
) => Promise<RalphExecutionProfileApplyResult>;

type RalphCapabilityContractApplyResult = {
	readonly applied: boolean;
	readonly reason?: string;
};

type RalphCapabilityContractApplier = (
	contract: RalphCapabilityContract,
	target: "controller" | "child",
) => Promise<RalphCapabilityContractApplyResult>;

type ReplacementSessionContext = ExtensionCommandContext & {
	readonly sendUserMessage: (
		content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
		options?: Parameters<ExtensionAPI["sendUserMessage"]>[1],
	) => Promise<void>;
};

type NewSessionSetup = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["setup"];

type SessionReplacementCommandContext = Omit<
	ExtensionCommandContext,
	"newSession" | "switchSession"
> & {
	readonly newSession: (options?: {
		readonly parentSession?: string;
		readonly setup?: NewSessionSetup;
		readonly withSession?: (ctx: ReplacementSessionContext) => Promise<void>;
	}) => Promise<{ readonly cancelled: boolean }>;
	readonly switchSession: (
		sessionPath: string,
		options?: { readonly withSession?: (ctx: ReplacementSessionContext) => Promise<void> },
	) => Promise<{ readonly cancelled: boolean }>;
};

type RalphSessionContext = ExtensionCommandContext | ReplacementSessionContext;

type RalphToolActivationContext = {
	readonly setActiveTools: ExtensionAPI["setActiveTools"];
};

function hasRalphToolActivationContext(
	ctx: RalphSessionContext,
): ctx is RalphSessionContext & RalphToolActivationContext {
	const candidate = ctx as { readonly setActiveTools?: unknown };
	return typeof candidate.setActiveTools === "function";
}

type RalphCommandBoundaryHandle = RalphCommandBoundary & {
	readonly getActiveContext: () => RalphSessionContext;
};

const RALPH_PROMPT_DISPATCHERS_GLOBAL = "__tau_ralph_prompt_dispatchers";
const RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL = "__tau_ralph_execution_profile_appliers";
const RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL = "__tau_ralph_capability_contract_appliers";

type RalphGlobalState = typeof globalThis & {
	[RALPH_PROMPT_DISPATCHERS_GLOBAL]?: Map<string, RalphPromptDispatcher>;
	[RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL]?: Map<string, RalphExecutionProfileApplier>;
	[RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL]?: Map<
		string,
		RalphCapabilityContractApplier
	>;
};

function getRalphPromptDispatchers(): Map<string, RalphPromptDispatcher> {
	const globalState = globalThis as RalphGlobalState;
	const existing = globalState[RALPH_PROMPT_DISPATCHERS_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphPromptDispatcher>();
	globalState[RALPH_PROMPT_DISPATCHERS_GLOBAL] = registry;
	return registry;
}

function registerRalphPromptDispatcher(
	sessionFile: string | undefined,
	dispatcher: RalphPromptDispatcher,
): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphPromptDispatchers().set(sessionFile, dispatcher);
}

function unregisterRalphPromptDispatcher(sessionFile: string | undefined): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphPromptDispatchers().delete(sessionFile);
}

function getRalphExecutionProfileAppliers(): Map<string, RalphExecutionProfileApplier> {
	const globalState = globalThis as RalphGlobalState;
	const existing = globalState[RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphExecutionProfileApplier>();
	globalState[RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL] = registry;
	return registry;
}

function registerRalphExecutionProfileApplier(
	sessionFile: string | undefined,
	applier: RalphExecutionProfileApplier,
): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphExecutionProfileAppliers().set(sessionFile, applier);
}

function unregisterRalphExecutionProfileApplier(sessionFile: string | undefined): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphExecutionProfileAppliers().delete(sessionFile);
}

function getRalphCapabilityContractAppliers(): Map<string, RalphCapabilityContractApplier> {
	const globalState = globalThis as RalphGlobalState;
	const existing = globalState[RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphCapabilityContractApplier>();
	globalState[RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL] = registry;
	return registry;
}

function registerRalphCapabilityContractApplier(
	sessionFile: string | undefined,
	applier: RalphCapabilityContractApplier,
): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphCapabilityContractAppliers().set(sessionFile, applier);
}

function unregisterRalphCapabilityContractApplier(sessionFile: string | undefined): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphCapabilityContractAppliers().delete(sessionFile);
}

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

function isStaleExtensionContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("This extension ctx is stale after session replacement or reload");
}

function isIgnorableSessionContextError(error: unknown): boolean {
	return isManagedRuntimeDisposedError(error) || isStaleExtensionContextError(error);
}

function hasReplacementSender(ctx: RalphSessionContext): ctx is ReplacementSessionContext {
	return "sendUserMessage" in ctx && typeof ctx.sendUserMessage === "function";
}

function notifySafely(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	message: string,
	level: "error" | "info" | "warning" | undefined,
): void {
	try {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.notify(message, level);
	} catch (error) {
		if (!isIgnorableSessionContextError(error)) {
			throw error;
		}
	}
}

function formatCommandBoundaryError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string" &&
		error.message.length > 0
	) {
		return error.message;
	}
	if (typeof error === "string" && error.length > 0) {
		return error;
	}
	try {
		const json = JSON.stringify(error);
		if (typeof json === "string" && json.length > 0 && json !== "{}") {
			return json;
		}
	} catch {
		// Fall through to String(error).
	}
	return String(error);
}

function sessionFileFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	return typeof ctx.sessionManager.getSessionFile === "function"
		? ctx.sessionManager.getSessionFile()
		: undefined;
}

function sessionFileFromContextIfLive(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	try {
		return sessionFileFromContext(ctx);
	} catch (error) {
		if (isIgnorableSessionContextError(error)) {
			return undefined;
		}
		throw error;
	}
}

function readSandboxSessionOverride(
	ctx: Pick<ExtensionContext, "sessionManager">,
): SandboxConfig | undefined {
	const sandbox = loadPersistedState(ctx).sandbox;
	if (typeof sandbox !== "object" || sandbox === null) {
		return undefined;
	}

	const sessionOverride = sandbox["sessionOverride"];
	if (typeof sessionOverride !== "object" || sessionOverride === null) {
		return undefined;
	}
	const sessionOverrideRecord = sessionOverride as Record<string, unknown>;

	const nextSessionOverride: SandboxConfig = {};
	const preset = sessionOverrideRecord["preset"];
	if (preset === "read-only" || preset === "workspace-write" || preset === "full-access") {
		nextSessionOverride.preset = preset;
	}

	const subagent = sessionOverrideRecord["subagent"];
	if (typeof subagent === "boolean") {
		nextSessionOverride.subagent = subagent;
	}

	const approvalTimeoutSeconds = sessionOverrideRecord["approvalTimeoutSeconds"];
	if (
		typeof approvalTimeoutSeconds === "number" &&
		Number.isFinite(approvalTimeoutSeconds) &&
		Number.isInteger(approvalTimeoutSeconds) &&
		approvalTimeoutSeconds > 0
	) {
		nextSessionOverride.approvalTimeoutSeconds = approvalTimeoutSeconds;
	}

	if (Object.keys(nextSessionOverride).length === 0) {
		return undefined;
	}

	return nextSessionOverride;
}

function readCliSandboxOverride(pi: ExtensionAPI): SandboxConfig | undefined {
	const sandboxMode = pi.getFlag("sandbox-mode");
	if (typeof sandboxMode !== "string") {
		return undefined;
	}

	const modeMap: Record<string, SandboxPreset> = {
		"read-only": "read-only",
		readonly: "read-only",
		"workspace-write": "workspace-write",
		agent: "workspace-write",
		"full-access": "full-access",
		full: "full-access",
	};
	const preset = modeMap[sandboxMode.toLowerCase()];
	return preset === undefined ? undefined : { preset };
}

function captureSandboxProfile(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): ResolvedSandboxConfig {
	const sessionOverride = readSandboxSessionOverride(ctx);
	const cliOverride = readCliSandboxOverride(pi);
	return computeEffectiveConfig({
		workspaceRoot: discoverWorkspaceRoot(ctx.cwd),
		sessionOverride: { ...sessionOverride, ...cliOverride },
	});
}

function sandboxSessionStateFromProfile(profile: ResolvedSandboxConfig): {
	readonly sandbox: { readonly sessionOverride: SandboxConfig };
} {
	return {
		sandbox: {
			sessionOverride: {
				preset: profile.preset,
				subagent: profile.subagent,
				approvalTimeoutSeconds: profile.approvalTimeoutSeconds,
			},
		},
	};
}

function formatLoop(loop: LoopState): string {
	const status = describeLoopStatus(loop);
	const iter =
		loop.maxIterations > 0 ? `${loop.iteration}/${loop.maxIterations}` : `${loop.iteration}`;
	return `${loop.name}: ${status.icon} ${status.label} (iteration ${iter})`;
}

function formatTokenCount(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(tokens / 1_000_000).toFixed(2).replace(/\.00$/, "")}m`;
}

function formatCostUsd(cost: number): string {
	return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function activeRuntimeMs(state: LoopState, nowMs: number): number {
	const activeStartedAt = Option.getOrUndefined(state.metrics.activeStartedAt);
	if (activeStartedAt === undefined) {
		return state.metrics.activeDurationMs;
	}
	const startedMs = Date.parse(activeStartedAt);
	if (!Number.isFinite(startedMs)) {
		return state.metrics.activeDurationMs;
	}
	return state.metrics.activeDurationMs + Math.max(0, nowMs - startedMs);
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
  /ralph resume <name> [options]      Resume a paused or completed loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph configure [name]             Interactive configuration for a Ralph loop
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

const RALPH_CONTINUE_TOOL_NAME = "ralph_continue";
const RALPH_FINISH_TOOL_NAME = "ralph_finish";

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

	const syncPromptDispatcher = (ctx: Pick<ExtensionContext, "sessionManager">): void => {
		registerRalphPromptDispatcher(sessionFileFromContext(ctx), (prompt) => {
			pi.sendUserMessage(prompt);
		});
	};

	const applyExecutionProfileInContext = (
		profile: ExecutionProfile,
		profileContext: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
	): Promise<RalphExecutionProfileApplyResult> =>
		withPromptModes((promptModes) =>
			promptModes
				.applyExecutionProfile(profile, profileContext, {
					notifyOnSuccess: false,
					persist: false,
					ephemeral: true,
				})
				.pipe(
					Effect.map((applyResult) =>
						applyResult.applied
							? { applied: true as const }
							: { applied: false as const, reason: applyResult.reason },
					),
				),
		).catch((error) => ({
			applied: false as const,
			reason: formatCommandBoundaryError(error),
		}));

	const syncExecutionProfileApplier = (
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "ui">,
	): void => {
		registerRalphExecutionProfileApplier(sessionFileFromContext(ctx), (profile) =>
			applyExecutionProfileInContext(profile, ctx),
		);
	};

	const applyCapabilityContractWithPi = (
		contract: RalphCapabilityContract,
		target: "controller" | "child",
	): RalphCapabilityContractApplyResult => {
		try {
			const tools = effectiveToolNames(contract, target);
			pi.setActiveTools([...tools]);
			return { applied: true as const };
		} catch (error) {
			return {
				applied: false as const,
				reason: formatCommandBoundaryError(error),
			};
		}
	};

	const syncCapabilityContractApplier = (ctx: Pick<ExtensionContext, "sessionManager">): void => {
		const registeredSessionFile = sessionFileFromContext(ctx);
		registerRalphCapabilityContractApplier(registeredSessionFile, (contract, target) => {
			const liveSessionFile = sessionFileFromContextIfLive(ctx);
			if (liveSessionFile !== registeredSessionFile) {
				return Promise.resolve({
					applied: false as const,
					reason: `registered capability contract applier is not live for ${registeredSessionFile ?? "the session"}`,
				});
			}
			return Promise.resolve(applyCapabilityContractWithPi(contract, target));
		});
	};

	const commandBoundaryFromContext = (
		ctx: ExtensionCommandContext,
	): RalphCommandBoundaryHandle => {
		let currentSessionFile = sessionFileFromContext(ctx);
		let activeContext: RalphSessionContext = ctx;
		let hasReplacedSession = false;
		const initialSandboxProfile = captureSandboxProfile(pi, ctx);
		const sessionControl = (): SessionReplacementCommandContext =>
			activeContext as SessionReplacementCommandContext;

		const bindReplacementContext = (
			replacementCtx: ReplacementSessionContext,
			fallbackSessionFile: string | undefined,
		): void => {
			hasReplacedSession = true;
			activeContext = replacementCtx;
			currentSessionFile =
				sessionFileFromContext(replacementCtx) ?? fallbackSessionFile ?? currentSessionFile;
		};

		const switchSession: RalphCommandBoundary["switchSession"] = Effect.fn(
			"RalphCommandBoundary.switchSession",
		)(function* (targetSessionFile) {
			const result = yield* Effect.tryPromise(() =>
				sessionControl().switchSession(targetSessionFile, {
					withSession: async (replacementCtx) => {
						bindReplacementContext(replacementCtx, targetSessionFile);
					},
				}),
			).pipe(Effect.catch(() => Effect.succeed({ cancelled: true as const })));
			if (!result.cancelled) {
				currentSessionFile = currentSessionFile ?? targetSessionFile;
			}
			return result;
		});

		const newSession: RalphCommandBoundary["newSession"] = Effect.fn(
			"RalphCommandBoundary.newSession",
		)(function* (options) {
			let createdSessionFile: string | undefined;
			const result = yield* Effect.tryPromise(() =>
				sessionControl().newSession({
					parentSession: options.parentSession,
					setup: async (sessionManager) => {
						createdSessionFile = sessionManager.getSessionFile();
						sessionManager.appendCustomEntry(
							TAU_PERSISTED_STATE_TYPE,
							sandboxSessionStateFromProfile(options.sandboxProfile),
						);
					},
					withSession: async (replacementCtx) => {
						bindReplacementContext(replacementCtx, createdSessionFile);
					},
				}),
			).pipe(Effect.catch(() => Effect.succeed({ cancelled: true as const })));
			if (!result.cancelled) {
				currentSessionFile = currentSessionFile ?? createdSessionFile;
			}
			return result;
		});

		const applyExecutionProfile: RalphCommandBoundary["applyExecutionProfile"] = Effect.fn(
			"RalphCommandBoundary.applyExecutionProfile",
		)(function* (profile) {
			const targetSessionFile = currentSessionFile;
			if (targetSessionFile !== undefined) {
				const applier = getRalphExecutionProfileAppliers().get(targetSessionFile);
				if (applier) {
					return yield* Effect.promise(() => applier(profile));
				}
			}

			const profileContext = activeContext;
			const liveSessionFile = sessionFileFromContextIfLive(profileContext);
			if (targetSessionFile === undefined || liveSessionFile === targetSessionFile) {
				return yield* Effect.promise(() =>
					applyExecutionProfileInContext(profile, profileContext),
				);
			}

			return {
				applied: false as const,
				reason: `no execution profile applier is registered for ${targetSessionFile}`,
			};
		});

		const applyCapabilityContract: RalphCommandBoundary["applyCapabilityContract"] = Effect.fn(
			"RalphCommandBoundary.applyCapabilityContract",
		)(function* (contract, target) {
			const targetSessionFile = currentSessionFile;
			if (hasReplacedSession && hasRalphToolActivationContext(activeContext)) {
				const toolContext = activeContext;
				return yield* Effect.sync(() => {
					try {
						const tools = effectiveToolNames(contract, target);
						toolContext.setActiveTools([...tools]);
						return { applied: true as const };
					} catch (error) {
						return {
							applied: false as const,
							reason: formatCommandBoundaryError(error),
						};
					}
				});
			}

			if (targetSessionFile !== undefined) {
				const applier = getRalphCapabilityContractAppliers().get(targetSessionFile);
				if (applier) {
					const result = yield* Effect.promise(() => applier(contract, target));
					if (result.applied) {
						return result;
					}
					const applierIsStale =
						result.reason?.startsWith("registered capability contract applier is not live") ===
							true || isStaleExtensionContextError(result.reason ?? "");
					if (applierIsStale) {
						unregisterRalphCapabilityContractApplier(targetSessionFile);
					}
					if (!applierIsStale) {
						return result;
					}
				}
			}

			if (hasReplacedSession) {
				return target === "controller"
					? { applied: true as const }
					: {
							applied: false as const,
							reason: `no capability contract applier is registered for ${targetSessionFile ?? "the replacement session"}`,
						};
			}

			return yield* Effect.sync(() => {
				const result = applyCapabilityContractWithPi(contract, target);
				if (
					target === "controller" &&
					!result.applied &&
					isStaleExtensionContextError(result.reason ?? "")
				) {
					return { applied: true as const };
				}
				return result;
			});
		});

		const captureBoundarySandboxProfile = Effect.succeed(initialSandboxProfile);

		const sendFollowUp: RalphCommandBoundary["sendFollowUp"] = Effect.fn(
			"RalphCommandBoundary.sendFollowUp",
		)(function* (prompt) {
			return yield* Effect.sync(() => {
				const targetSessionFile = currentSessionFile;
				if (targetSessionFile === undefined) {
					return {
						dispatched: false as const,
						reason: "iteration session file is unavailable",
					};
				}

				const dispatcher = getRalphPromptDispatchers().get(targetSessionFile);
				if (dispatcher) {
					dispatcher(prompt);
					return { dispatched: true as const };
				}

				if (sessionFileFromContextIfLive(ctx) === targetSessionFile) {
					pi.sendUserMessage(prompt);
					return { dispatched: true as const };
				}

				const sessionContext = activeContext;
				if (
					hasReplacementSender(sessionContext) &&
					sessionFileFromContextIfLive(sessionContext) === targetSessionFile
				) {
					void sessionContext.sendUserMessage(prompt).catch(() => undefined);
					return { dispatched: true as const };
				}

				return {
					dispatched: false as const,
					reason: `no prompt dispatcher is registered for ${targetSessionFile}`,
				};
			});
		});

		return {
			cwd: ctx.cwd,
			getSessionFile: () => currentSessionFile,
			getActiveContext: () => activeContext,
			switchSession,
			newSession,
			captureSandboxProfile: captureBoundarySandboxProfile,
			applyExecutionProfile,
			applyCapabilityContract,
			sendFollowUp,
		};
	};

	const syncRalphHandshakeTools = async (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<void> => {
		const sessionFile = sessionFileFromContext(ctx);
		if (sessionFile === undefined) {
			setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, false);
			setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, false);
			return;
		}

		const state = await withRalph((ralph) =>
			ralph
				.findLoopBySessionFile(ctx.cwd, sessionFile)
				.pipe(Effect.map(Option.getOrUndefined)),
		);

		const enabled =
			state !== undefined &&
			state.status === "active" &&
			Option.getOrUndefined(state.activeIterationSessionFile) === sessionFile;
		setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, enabled);
		setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, enabled);
	};

	const syncRalphHandshakeToolsSafely = async (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "hasUI" | "ui">,
	): Promise<void> => {
		try {
			await syncRalphHandshakeTools(ctx);
		} catch (error) {
			if (isIgnorableSessionContextError(error)) {
				return;
			}
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			if (isManagedRuntimeDisposedError(error)) {
				return;
			}
			throw error;
		}
	};

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
		const runtimeMs = activeRuntimeMs(state, Date.now());

		ctx.ui.setStatus(
			"ralph",
			theme.fg("accent", `🔄 ${state.name} (${state.iteration}${maxStr})`),
		);

		const lines = [
			theme.fg("accent", theme.bold("Ralph Wiggum")),
			theme.fg("muted", `Loop: ${state.name}`),
			theme.fg("dim", `Status: ${status.icon} ${status.label}`),
			theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
			theme.fg("dim", `Runtime: ${formatDuration(runtimeMs)}`),
			theme.fg(
				"dim",
				`Usage: ${formatTokenCount(state.metrics.totalTokens)} tokens · ${formatCostUsd(state.metrics.totalCostUsd)}`,
			),
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
		const boundary = commandBoundaryFromContext(ctx);
		const result = await withRalph((ralph) => ralph.runLoop(boundary, loopName));
		const resultContext = boundary.getActiveContext();
		if (Option.isSome(result.message)) {
			notifySafely(resultContext, result.message.value, "info");
		}
		if (Option.isSome(result.banner)) {
			notifySafely(resultContext, result.banner.value, "info");
		}
		try {
			await updateUI(resultContext.cwd, resultContext);
		} catch (error) {
			if (!isIgnorableSessionContextError(error)) {
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
						const sandboxProfile = captureSandboxProfile(pi, ctx);

						// Capture capability contract from current runtime before the session
						// becomes Ralph-owned, so ambient Pi state is pinned.
						const agentRegistry = await Effect.runPromise(AgentRegistry.load(ctx.cwd));
						const availableAgents = agentRegistry.names();
						const controllerSessionFile = sessionFileFromContext(ctx);
						const enabledAgents = await resolveEnabledAgentsForSessionAuthoritative(
							ctx.cwd,
							controllerSessionFile,
							availableAgents,
						);
						const capabilityContract = captureCapabilityContract({
							activeTools: pi.getActiveTools(),
							allTools: pi.getAllTools(),
							agentRegistry,
							enabledAgents,
						});

						const start = await withRalph((ralph) =>
							ralph.startLoopState(ctx.cwd, {
								loopName,
								taskFile,
								executionProfile,
								sandboxProfile,
								maxIterations: parsed.value.maxIterations,
								itemsPerIteration: parsed.value.itemsPerIteration,
								reflectEvery: parsed.value.reflectEvery,
								reflectInstructions: parsed.value.reflectInstructions,
								controllerSessionFile:
									controllerSessionFile === undefined
										? Option.none()
										: Option.some(controllerSessionFile),
								defaultTaskTemplate: DEFAULT_TEMPLATE,
								capabilityContract,
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

					case "configure": {
						if (!ctx.hasUI) {
							ctx.ui.notify("/ralph configure requires an interactive UI.", "warning");
							return;
						}

						const arg = rest.trim();
						const loops = await listLoops(ctx.cwd);
						// listLoops already returns only Ralph loops via RalphRepo.listLoops
						const ralphLoops = loops;

						let targetLoopName: string | undefined;

						if (arg) {
							targetLoopName = sanitizeLoopName(arg);
						} else {
							// Try current Ralph-owned loop
							const sessionFile = sessionFileFromContext(ctx);
							const owned = await withRalph((ralph) =>
								ralph
									.findLoopBySessionFile(ctx.cwd, sessionFile)
									.pipe(Effect.map(Option.getOrUndefined)),
							);
							if (owned) {
								targetLoopName = owned.name;
							}
						}

						if (!targetLoopName) {
							// Show selector of configurable Ralph loops
							if (ralphLoops.length === 0) {
								ctx.ui.notify("No Ralph loops found to configure.", "info");
								return;
							}
							const items: SelectItem[] = ralphLoops.map((loop) => ({
								value: loop.name,
								label: `${loop.name} (${loop.status}, iter ${loop.iteration})`,
								description: loop.taskFile,
							}));
							await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
								const selector = new SelectList(items, Math.min(items.length + 2, 10), {
									selectedPrefix: (text) => theme.fg("accent", text),
									selectedText: (text) => theme.fg("accent", theme.bold(text)),
									description: (text) => theme.fg("dim", text),
									scrollInfo: (text) => theme.fg("muted", text),
									noMatch: (text) => theme.fg("warning", text),
								});
								selector.onSelect = (item) => {
									targetLoopName = item.value;
									done(undefined as unknown as void);
								};
								selector.onCancel = () => done(undefined as unknown as void);
								return selector;
							});
							if (!targetLoopName) return;
						}

						const loop = ralphLoops.find((l) => l.name === targetLoopName);
						if (!loop) {
							ctx.ui.notify(`Loop "${targetLoopName}" not found.`, "error");
							return;
						}

						const state = loop;
						const sandboxStr = Option.match(state.sandboxProfile, {
							onNone: () => "default",
							onSome: (s) => s.preset ?? "custom",
						});
						const ep = state.executionProfile;
						const toolsActive = state.capabilityContract.tools.activeNames;
						const agentsEnabled = state.capabilityContract.agents.enabledNames;

						const buildItems = (): SettingItem[] => [
							{
								id: "maxIterations",
								label: "Max iterations",
								description: "Stop after N iterations (0 = unlimited)",
								currentValue: String(state.maxIterations),
							},
							{
								id: "itemsPerIteration",
								label: "Items per iteration",
								description: "Suggested work items per Ralph turn (0 = no hint)",
								currentValue: String(state.itemsPerIteration),
							},
							{
								id: "reflectEvery",
								label: "Reflect every",
								description: "Reflection checkpoint frequency in iterations (0 = off)",
								currentValue: String(state.reflectEvery),
							},
							{
								id: "tools",
								label: "Active tools",
								description: `User-configurable tools (${toolsActive.length} active). System-managed: ralph_continue, ralph_finish`,
								currentValue: toolsActive.join(", ") || "none",
							},
							{
								id: "agents",
								label: "Enabled agents",
								description: `Agents enabled for this loop (${agentsEnabled.length})`,
								currentValue: agentsEnabled.join(", ") || "none",
							},
							{
								id: "executionProfile",
								label: "Execution profile",
								description: "Pinned mode, model, and thinking level",
								currentValue: `${ep.selector.mode} / ${ep.promptProfile.model ?? "default"} / ${ep.promptProfile.thinking ?? "default"}`,
							},
							{
								id: "sandboxProfile",
								label: "Sandbox profile",
								description: "Pinned sandbox preset and overrides",
								currentValue: sandboxStr,
							},
							{
								id: "reflectInstructions",
								label: "Reflection instructions",
								description: "Custom prompt for reflection checkpoints",
								currentValue:
									state.reflectInstructions.slice(0, 40) +
									(state.reflectInstructions.length > 40 ? "…" : ""),
							},
						];

						const pendingMutations: RalphConfigMutation[] = [];
						let dirty = false;

						await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
							const items = buildItems();
							const settingsList = new SettingsList(
								items,
								Math.min(items.length + 2, 12),
								{
									label: (text, selected) =>
										selected ? theme.fg("accent", theme.bold(text)) : text,
									value: (text, selected) =>
										selected ? theme.fg("accent", text) : theme.fg("dim", text),
									description: (text) => theme.fg("muted", text),
									cursor: theme.fg("accent", "> "),
									hint: (text) => theme.fg("dim", text),
								},
								(id, _newValue) => {
									if (id === "maxIterations" || id === "itemsPerIteration" || id === "reflectEvery") {
										// For numeric fields, open an input submenu would be ideal.
										// Since SettingsList cycles values or opens submenus, we use a simple prompt approach:
										ctx.ui
											.input(`Enter new value for ${id} (non-negative integer):`, String(state[id as keyof LoopState]))
											.then((value) => {
												if (value === undefined) return;
												const num = Number.parseInt(value, 10);
												if (Number.isInteger(num) && num >= 0) {
													pendingMutations.push({ kind: id, value: num } as RalphConfigMutation);
													dirty = true;
													settingsList.updateValue(id, String(num));
												} else {
													ctx.ui.notify(`Invalid value: ${value}`, "error");
												}
											});
									}
									if (id === "tools") {
										const available = state.capabilityContract.tools.availableSnapshot.map((t) => t.name);
										const allItems: SelectItem[] = available.map((name) => ({
											value: name,
											label: name,
											description: state.capabilityContract.tools.availableSnapshot.find((t) => t.name === name)?.description ?? "",
										}));
										ctx.ui
											.custom<void>((_tui2, theme2, _kb2, done2) => {
												const sel = new SelectList(
													allItems,
													Math.min(allItems.length + 2, 10),
													{
														selectedPrefix: (text) => theme2.fg("accent", text),
														selectedText: (text) => theme2.fg("accent", theme2.bold(text)),
														description: (text) => theme2.fg("dim", text),
														scrollInfo: (text) => theme2.fg("muted", text),
														noMatch: (text) => theme2.fg("warning", text),
													},
												);
												const selected = new Set(toolsActive);
												sel.onSelect = (item) => {
													if (selected.has(item.value)) {
														selected.delete(item.value);
													} else {
														selected.add(item.value);
													}
													sel.invalidate();
												};
												sel.onCancel = () => {
													const next = Array.from(selected).sort();
													pendingMutations.push({
														kind: "capabilityContractTools",
														activeNames: next,
													});
													dirty = true;
													settingsList.updateValue("tools", next.join(", ") || "none");
													done2(undefined as unknown as void);
												};
												return sel;
											})
												.catch(() => undefined);
									}
									if (id === "agents") {
										const registry = state.capabilityContract.agents.registrySnapshot;
										const allItems: SelectItem[] = registry.map((a) => ({
											value: a.name,
											label: a.name,
											description: a.description,
										}));
										ctx.ui
											.custom<void>((_tui2, theme2, _kb2, done2) => {
												const sel = new SelectList(
													allItems,
													Math.min(allItems.length + 2, 10),
													{
														selectedPrefix: (text) => theme2.fg("accent", text),
														selectedText: (text) => theme2.fg("accent", theme2.bold(text)),
														description: (text) => theme2.fg("dim", text),
														scrollInfo: (text) => theme2.fg("muted", text),
														noMatch: (text) => theme2.fg("warning", text),
													},
												);
												const selected = new Set(agentsEnabled);
												sel.onSelect = (item) => {
													if (selected.has(item.value)) {
														selected.delete(item.value);
													} else {
														selected.add(item.value);
													}
													sel.invalidate();
												};
												sel.onCancel = () => {
													const next = Array.from(selected).sort();
													pendingMutations.push({
														kind: "capabilityContractAgents",
														enabledNames: next,
													});
													dirty = true;
													settingsList.updateValue("agents", next.join(", ") || "none");
													done2(undefined as unknown as void);
												};
												return sel;
											})
												.catch(() => undefined);
									}
									if (id === "executionProfile") {
										// Recapture from current session
										captureCurrentExecutionProfile(ctx).then((profile) => {
											if (profile) {
												pendingMutations.push({
													kind: "executionProfile",
													profile,
												});
												dirty = true;
												settingsList.updateValue(
													"executionProfile",
													`${profile.selector.mode} / ${profile.promptProfile.model ?? "default"} / ${profile.promptProfile.thinking ?? "default"}`,
												);
												ctx.ui.notify("Execution profile recaptured from current session.", "info");
											} else {
												ctx.ui.notify("Could not capture current execution profile.", "error");
											}
										});
									}
									if (id === "sandboxProfile") {
										const profile = captureSandboxProfile(pi, ctx);
										pendingMutations.push({
											kind: "sandboxProfile",
											profile,
										});
										dirty = true;
										settingsList.updateValue("sandboxProfile", profile.preset ?? "custom");
										ctx.ui.notify("Sandbox profile recaptured from current session.", "info");
									}
									if (id === "reflectInstructions") {
										ctx.ui
											.editor("Reflection instructions", state.reflectInstructions)
											.then((value) => {
												if (value === undefined) return;
												pendingMutations.push({
													kind: "reflectInstructions",
													value,
												});
												dirty = true;
												settingsList.updateValue(
													"reflectInstructions",
													value.slice(0, 40) + (value.length > 40 ? "…" : ""),
												);
											});
									}
								},
								() => {
									// onCancel = save if dirty
									if (dirty && pendingMutations.length > 0) {
										withRalph((ralph) =>
											ralph.configureLoopMany(ctx.cwd, targetLoopName!, pendingMutations),
										)
											.then((result) => {
												if (result.status === "updated") {
													ctx.ui.notify(
														`Updated loop "${targetLoopName}" configuration.`,
														"info",
													);
												} else if (result.status === "refused") {
													ctx.ui.notify(
														`Configuration refused: ${result.reason}`,
														"warning",
													);
												}
											})
											.catch((error) => {
												ctx.ui.notify(
													String(error),
													"error",
												);
											});
									}
									done(undefined as unknown as void);
								},
								{ enableSearch: true },
							);
								return settingsList;
							});
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
			} finally {
				await syncRalphHandshakeToolsSafely(ctx);
			}
		},
	});

	pi.registerTool({
		name: "ralph_continue",
		label: "Ralph Continue",
		description:
			"Signal that this Ralph iteration is complete and Ralph should continue to the next iteration.",
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop or if a Ralph decision was already recorded for this iteration.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const result = await withRalph((ralph) =>
					ralph.recordContinue(ctx.cwd, sessionFileFromContext(ctx)),
				);
				await updateUI(ctx.cwd, ctx);
				await syncRalphHandshakeToolsSafely(ctx);
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
			return new Text(theme.fg("toolTitle", theme.bold("ralph_continue")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "ralph_finish",
		label: "Ralph Finish",
		description:
			"Signal that the overall Ralph loop is complete. Provide a short completion message.",
		promptSnippet: "Finish an active Ralph loop with a short completion message.",
		promptGuidelines: [
			"Call this only when the overall Ralph loop is complete.",
			"Provide a short concrete completion message.",
			"Do not call this if there is no active loop or if a Ralph decision was already recorded for this iteration.",
		],
		parameters: Type.Object({
			message: Type.String({
				description: "Short completion message for the finished Ralph loop",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await withRalph((ralph) =>
					ralph.recordFinish(ctx.cwd, sessionFileFromContext(ctx), params.message),
				);
				await updateUI(ctx.cwd, ctx);
				await syncRalphHandshakeToolsSafely(ctx);
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

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ralph_finish "));
			text += theme.fg("accent", String(args.message ?? ""));
			return new Text(text, 0, 0);
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
			const inActiveIteration =
				state !== undefined &&
				state.status === "active" &&
				Option.getOrUndefined(state.activeIterationSessionFile) === sessionFile;
			setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, inActiveIteration);
			setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, inActiveIteration);

			if (!inActiveIteration || state === undefined) {
				return;
			}

			const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
			let instructions = `You are in a Ralph loop working on: ${state.taskFile}\n`;
			if (state.itemsPerIteration > 0) {
				instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
			}
			instructions += "- Update the task file as you progress\n";
			instructions +=
				"- If the Ralph loop is complete, call ralph_finish with a short message\n";
			instructions +=
				"- If this iteration is done and Ralph should continue, call ralph_continue\n";
			instructions +=
				"- If a recoverable tool call fails, correct it and continue the iteration\n";
			instructions +=
				"- Do not end the iteration with free text alone; end with exactly one Ralph loop tool";

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
				notifySafely(ctx, result.banner.value, "info");
				try {
					await updateUI(ctx.cwd, ctx);
				} catch (error) {
					if (!isManagedRuntimeDisposedError(error)) {
						throw error;
					}
				}
			}
			await syncRalphHandshakeToolsSafely(ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			syncPromptDispatcher(ctx);
			syncExecutionProfileApplier(ctx);
			syncCapabilityContractApplier(ctx);
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
			await syncRalphHandshakeToolsSafely(ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		try {
			syncPromptDispatcher(ctx);
			syncExecutionProfileApplier(ctx);
			syncCapabilityContractApplier(ctx);
			await withRalph((ralph) =>
				ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFileFromContext(ctx)),
			);
			await updateUI(ctx.cwd, ctx);
			await syncRalphHandshakeToolsSafely(ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_fork", async (_event, ctx) => {
		try {
			syncPromptDispatcher(ctx);
			syncExecutionProfileApplier(ctx);
			syncCapabilityContractApplier(ctx);
			await withRalph((ralph) =>
				ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFileFromContext(ctx)),
			);
			await updateUI(ctx.cwd, ctx);
			await syncRalphHandshakeToolsSafely(ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			unregisterRalphPromptDispatcher(sessionFileFromContext(ctx));
			unregisterRalphExecutionProfileApplier(sessionFileFromContext(ctx));
			unregisterRalphCapabilityContractApplier(sessionFileFromContext(ctx));
			await withRalph((ralph) =>
				ralph.persistOwnedLoopOnShutdown(ctx.cwd, sessionFileFromContext(ctx)),
			);
			setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, false);
			setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, false);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});
}
