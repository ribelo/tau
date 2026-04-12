import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomBytes } from "node:crypto";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateTail, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import type { TruncationResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { Effect, Option } from "effect";

import { Sandbox } from "../services/sandbox.js";
import { PromptModes } from "../services/prompt-modes.js";
import {
	LoopEngine,
	type LoopEngineService,
} from "../services/loop-engine.js";
import {
	type BenchmarkProgress,
	type ExecuteBenchmarkInput,
	type RunDetails,
} from "../services/autoresearch.js";
import type { ExecutionProfile } from "../execution/schema.js";
import { getSandboxedBashOperations } from "../sandbox/index.js";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
	LoopContractValidationError,
	LoopLifecycleConflictError,
	LoopOwnershipValidationError,
	LoopTaskAlreadyExistsError,
	LoopTaskNotFoundError,
	LoopAmbiguousOwnershipError,
} from "../loops/errors.js";
import {
	decodeLoopTaskIdSync,
	decodeAutoresearchPhaseSnapshotJsonSync,
	decodeLoopPersistedStateJsonSync,
	encodeLoopPersistedStateJsonSync,
	type AutoresearchLoopPersistedState,
	type IsolatedCheckout,
	type LoopPersistedState,
	type LoopSessionRef,
} from "../loops/schema.js";
import {
	loopPhaseFile,
	loopRunDirectory,
	loopRunsDirectory,
	loopStateFile,
	loopTaskFile,
} from "../loops/paths.js";
import {
	normalizeAutoresearchTaskContractInput,
	parseAutoresearchTaskDocument,
	renderAutoresearchTaskDocument,
} from "./task-contract.js";
import {
	AutoresearchValidationError,
	AutoresearchGitError,
} from "./errors.js";
import {
	formatNum,
	formatElapsed,
	parseMetricLines,
	parseAsiLines,
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
} from "./helpers.js";

// ------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------

function stripSurroundingQuotes(value: string): string {
	return value.replace(/^"|"$/g, "");
}

function tokenizeCommandArgs(args: string): ReadonlyArray<string> {
	return (args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
		stripSurroundingQuotes(token),
	);
}

function commandSessionRef(
	ctx: Pick<ExtensionCommandContext, "sessionManager">,
): Option.Option<LoopSessionRef> {
	const sessionFile =
		typeof ctx.sessionManager.getSessionFile === "function"
			? ctx.sessionManager.getSessionFile()
			: undefined;
	if (sessionFile === undefined) {
		return Option.none();
	}
	return Option.some({
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile,
	});
}

function isAutoresearchLoopState(state: LoopPersistedState): boolean {
	return (
		state.kind === "autoresearch" ||
		(state.kind === "blocked_manual_resolution" && state.previousKind === "autoresearch")
	);
}

function formatAutoresearchLoopState(state: LoopPersistedState): string {
	if (state.kind === "autoresearch") {
		const pendingRun = Option.match(state.autoresearch.pendingRunId, {
			onNone: () => "none",
			onSome: (runId) => runId,
		});
		const phase = Option.match(state.autoresearch.phaseId, {
			onNone: () => "none",
			onSome: (phaseId) => phaseId,
		});
		return `${state.taskId}: ${state.lifecycle} (phase=${phase}, pending_run=${pendingRun}, runs=${state.autoresearch.runCount})`;
	}
	if (state.kind === "blocked_manual_resolution") {
		return `${state.taskId}: blocked (${state.blocked.reasonCode}) ${state.blocked.message}`;
	}
	return `${state.taskId}: ${state.lifecycle}`;
}

function validateTaskId(input: string): string {
	return decodeLoopTaskIdSync(input.trim());
}

function createDefaultTaskDocument(taskId: string, goalText: string): string {
	const defaultContract = normalizeAutoresearchTaskContractInput({
		title: taskId,
		benchmarkCommand: "bash autoresearch.sh",
		checksCommand: Option.none(),
		metricName: "metric",
		metricUnit: "",
		metricDirection: "lower",
		scopeRoot: ".",
		scopePaths: ["."],
		offLimits: [],
		constraints: [],
		maxIterations: Option.none(),
	});
	return renderAutoresearchTaskDocument(defaultContract, goalText);
}

type AutoresearchRunOutcome = "keep" | "discard" | "crash" | "checks_failed";

type PersistedAutoresearchRun = {
	readonly kind: "autoresearch_run";
	readonly version: 1;
	readonly taskId: string;
	readonly runId: string;
	readonly runNumber: number;
	readonly phaseId: string;
	readonly createdAt: string;
	readonly childSession: LoopSessionRef;
	readonly controllerSession: LoopSessionRef;
	readonly benchmark: {
		readonly command: string;
		readonly durationSeconds: number;
		readonly exitCode: number | null;
		readonly timedOut: boolean;
		readonly passed: boolean;
		readonly logFile: string;
		readonly tailOutput: string;
	};
	readonly checks: {
		readonly command: string;
		readonly durationSeconds: number;
		readonly passed: boolean | null;
		readonly timedOut: boolean;
		readonly logFile: string | null;
		readonly outputTail: string;
	} | null;
	readonly parsed: {
		readonly metricName: string;
		readonly metricUnit: string;
		readonly metrics: Record<string, number> | null;
		readonly primary: number | null;
		readonly asi: Record<string, unknown> | null;
	};
	readonly fullOutputLogFile: string | null;
	readonly finalized: {
		readonly status: AutoresearchRunOutcome;
		readonly description: string;
		readonly decidedAt: string;
		readonly metrics: Record<string, number> | null;
		readonly asi: Record<string, unknown> | null;
	} | null;
};

const RUN_BENCHMARK_LOG_FILE = "benchmark.log";
const RUN_CHECKS_LOG_FILE = "checks.log";
const RUN_FULL_OUTPUT_LOG_FILE = "benchmark.full.log";
const RUN_RECORD_FILE = "run.json";
const LEGACY_AUTORESEARCH_ARTIFACTS = [
	".autoresearch",
	"autoresearch.jsonl",
	"autoresearch.md",
	"autoresearch.ideas.md",
	"autoresearch.program.md",
	"autoresearch.config.json",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionRefMatches(left: LoopSessionRef, right: LoopSessionRef): boolean {
	return left.sessionId === right.sessionId || left.sessionFile === right.sessionFile;
}

function writeAtomicFileSync(filePath: string, content: string): void {
	const parent = path.dirname(filePath);
	fs.mkdirSync(parent, { recursive: true });
	const tempPath = path.join(
		parent,
		`.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	fs.writeFileSync(tempPath, content, "utf-8");
	fs.renameSync(tempPath, filePath);
}

function assertNoLegacyAutoresearchLayout(cwd: string): void {
	const present = LEGACY_AUTORESEARCH_ARTIFACTS.filter((artifact) =>
		fs.existsSync(path.resolve(cwd, artifact)),
	);
	if (present.length === 0) {
		return;
	}
	throw new LoopContractValidationError({
		entity: "loops.autoresearch.legacy_layout",
		reason:
			`Legacy autoresearch artifacts are present: ${present.join(", ")}. ` +
			"Legacy autoresearch files are not imported automatically. Remove them or import them explicitly before creating task-scoped loops.",
	});
}

function requireAutoresearchLoopState(state: LoopPersistedState): AutoresearchLoopPersistedState {
	if (state.kind !== "autoresearch") {
		throw new AutoresearchValidationError({
			reason: `Task ${state.taskId} is ${state.kind}. Autoresearch tools require kind=autoresearch.`,
		});
	}
	return state;
}

function isLoopSessionRef(value: unknown): value is LoopSessionRef {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value["sessionId"] === "string" &&
		value["sessionId"].trim().length > 0 &&
		typeof value["sessionFile"] === "string" &&
		value["sessionFile"].trim().length > 0
	);
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNumericRecordOrNull(value: unknown): value is Record<string, number> | null {
	if (value === null) {
		return true;
	}
	if (!isRecord(value)) {
		return false;
	}
	for (const entry of Object.values(value)) {
		if (typeof entry !== "number" || !Number.isFinite(entry)) {
			return false;
		}
	}
	return true;
}

function isUnknownRecordOrNull(value: unknown): value is Record<string, unknown> | null {
	return value === null || isRecord(value);
}

function isRunOutcome(value: unknown): value is AutoresearchRunOutcome {
	return (
		value === "keep" ||
		value === "discard" ||
		value === "crash" ||
		value === "checks_failed"
	);
}

function isPersistedAutoresearchRun(value: unknown): value is PersistedAutoresearchRun {
	if (!isRecord(value)) {
		return false;
	}
	if (value["kind"] !== "autoresearch_run" || value["version"] !== 1) {
		return false;
	}
	if (
		typeof value["taskId"] !== "string" ||
		typeof value["runId"] !== "string" ||
		typeof value["phaseId"] !== "string" ||
		typeof value["createdAt"] !== "string" ||
		typeof value["runNumber"] !== "number"
	) {
		return false;
	}
	if (!isLoopSessionRef(value["childSession"]) || !isLoopSessionRef(value["controllerSession"])) {
		return false;
	}

	const benchmark = value["benchmark"];
	if (!isRecord(benchmark)) {
		return false;
	}
	if (
		typeof benchmark["command"] !== "string" ||
		typeof benchmark["durationSeconds"] !== "number" ||
		!isFiniteNumberOrNull(benchmark["exitCode"]) ||
		typeof benchmark["timedOut"] !== "boolean" ||
		typeof benchmark["passed"] !== "boolean" ||
		typeof benchmark["logFile"] !== "string" ||
		typeof benchmark["tailOutput"] !== "string"
	) {
		return false;
	}

	const checks = value["checks"];
	if (checks !== null) {
		if (!isRecord(checks)) {
			return false;
		}
		if (
			typeof checks["command"] !== "string" ||
			typeof checks["durationSeconds"] !== "number" ||
			(checks["passed"] !== null && typeof checks["passed"] !== "boolean") ||
			typeof checks["timedOut"] !== "boolean" ||
			(checks["logFile"] !== null && typeof checks["logFile"] !== "string") ||
			typeof checks["outputTail"] !== "string"
		) {
			return false;
		}
	}

	const parsed = value["parsed"];
	if (!isRecord(parsed)) {
		return false;
	}
	if (
		typeof parsed["metricName"] !== "string" ||
		typeof parsed["metricUnit"] !== "string" ||
		!isNumericRecordOrNull(parsed["metrics"]) ||
		!isFiniteNumberOrNull(parsed["primary"]) ||
		!isUnknownRecordOrNull(parsed["asi"])
	) {
		return false;
	}

	if (value["fullOutputLogFile"] !== null && typeof value["fullOutputLogFile"] !== "string") {
		return false;
	}

	const finalized = value["finalized"];
	if (finalized !== null) {
		if (!isRecord(finalized)) {
			return false;
		}
		if (
			!isRunOutcome(finalized["status"]) ||
			typeof finalized["description"] !== "string" ||
			typeof finalized["decidedAt"] !== "string" ||
			!isNumericRecordOrNull(finalized["metrics"]) ||
			!isUnknownRecordOrNull(finalized["asi"])
		) {
			return false;
		}
	}

	return true;
}

function parsePersistedRunRecord(content: string, runFile: string): PersistedAutoresearchRun {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch (error) {
		throw new LoopContractValidationError({
			entity: "loops.run",
			reason: `${runFile}: invalid JSON (${String(error)})`,
		});
	}

	if (!isPersistedAutoresearchRun(parsed)) {
		throw new LoopContractValidationError({
			entity: "loops.run",
			reason: `${runFile}: run record does not match the canonical schema.`,
		});
	}

	return parsed;
}

function listRunRecordsForTask(cwd: string, taskId: string): ReadonlyArray<PersistedAutoresearchRun> {
	const runsRoot = path.resolve(cwd, loopRunsDirectory(taskId));
	if (!fs.existsSync(runsRoot)) {
		return [];
	}

	const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	const runs: PersistedAutoresearchRun[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const runFile = path.join(runsRoot, entry.name, RUN_RECORD_FILE);
		if (!fs.existsSync(runFile)) {
			continue;
		}
		const runContent = fs.readFileSync(runFile, "utf-8");
		runs.push(parsePersistedRunRecord(runContent, runFile));
	}
	return runs;
}

// ------------------------------------------------------------------------------
// Benchmark execution
// ------------------------------------------------------------------------------

async function executeBenchmarkAsync(
	input: ExecuteBenchmarkInput & { readonly checksCommand?: Option.Option<string> },
	onUpdate:
		| ((result: { content: Array<{ type: "text"; text: string }>; details: BenchmarkProgress }) => void)
		| undefined,
	ops: BashOperations,
): Promise<RunDetails> {
	const {
		workDir,
		runDirectory,
		benchmarkLogPath,
		checksLogPath,
		command,
		timeoutSeconds,
		checksTimeoutSeconds,
		checksCommand,
		metricName,
		metricUnit,
		signal,
	} = input;

	const outputChunks: Buffer[] = [];
	let totalBytes = 0;

	const handleData = (data: Buffer) => {
		outputChunks.push(data);
		totalBytes += data.length;
	};

	const t0 = Date.now();
	let timerInterval: ReturnType<typeof setInterval> | undefined;

	if (onUpdate) {
		timerInterval = setInterval(() => {
			const elapsedMs = Date.now() - t0;
			const elapsed = formatElapsed(elapsedMs);
			const currentOutput = Buffer.concat(outputChunks).toString("utf-8");
			const tail = truncateTail(currentOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			onUpdate({
				content: [{ type: "text", text: tail.content || "" }],
				details: {
					phase: "running",
					elapsed,
					tailOutput: tail.content,
				},
			});
		}, 1000);
	}

	const benchmarkOptions: { onData: (data: Buffer) => void; timeout?: number; signal?: AbortSignal } = {
		onData: handleData,
	};
	if (timeoutSeconds > 0) {
		benchmarkOptions.timeout = timeoutSeconds;
	}
	if (signal) {
		benchmarkOptions.signal = signal;
	}

	const result = await ops.exec(command, workDir, benchmarkOptions);

	if (timerInterval) clearInterval(timerInterval);

	const durationSeconds = (Date.now() - t0) / 1000;
	const processTimedOut = result.exitCode === null;

	const fullOutput = Buffer.concat(outputChunks).toString("utf-8");

	fs.writeFileSync(benchmarkLogPath, fullOutput);

	const benchmarkPassed = result.exitCode === 0 && !processTimedOut;

	let checksPass: boolean | null = null;
	let checksTimedOut = false;
	let checksOutput = "";
	let checksDuration = 0;

	const explicitChecksCommand = checksCommand ?? Option.none<string>();
	const resolvedChecksCommand = Option.match(explicitChecksCommand, {
		onSome: (command) => command,
		onNone: () => null,
	});
	if (benchmarkPassed && resolvedChecksCommand !== null) {
		const checksChunks: Buffer[] = [];
		const ct0 = Date.now();
		const checksOptions: { onData: (data: Buffer) => void; timeout?: number; signal?: AbortSignal } = {
			onData: (data) => checksChunks.push(data),
		};
		if (checksTimeoutSeconds > 0) {
			checksOptions.timeout = checksTimeoutSeconds;
		}
		if (signal) {
			checksOptions.signal = signal;
		}

		const checksResult = await ops.exec(resolvedChecksCommand, workDir, checksOptions);

		checksDuration = (Date.now() - ct0) / 1000;
		checksTimedOut = checksResult.exitCode === null;
		checksPass = checksResult.exitCode === 0 && !checksTimedOut;
		checksOutput = Buffer.concat(checksChunks).toString("utf-8").trim();

		if (Option.isSome(checksLogPath)) {
			fs.writeFileSync(checksLogPath.value, checksOutput);
		}
	}

	const passed = benchmarkPassed && (checksPass === null || checksPass);
	const displayTruncation = truncateTail(fullOutput, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const llmTruncation = truncateTail(fullOutput, {
		maxLines: EXPERIMENT_MAX_LINES,
		maxBytes: EXPERIMENT_MAX_BYTES,
	});
	const truncation: TruncationResult | null = llmTruncation.truncated ? llmTruncation : null;

	const totalLines = fullOutput.split("\n").length;
	let fullOutputPath: string | undefined;
	if (totalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES) {
		fullOutputPath = path.join(os.tmpdir(), `pi-experiment-${randomBytes(8).toString("hex")}.log`);
		fs.writeFileSync(fullOutputPath, fullOutput);
	}

	const parsedMetricMap = parseMetricLines(fullOutput);
	const parsedMetrics = parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
	const parsedPrimary = parsedMetricMap.get(metricName) ?? null;

	return {
		runNumber: 0,
		runDirectory,
		benchmarkLogPath,
		checksLogPath,
		command,
		exitCode: result.exitCode,
		durationSeconds,
		passed,
		crashed: !passed,
		timedOut: processTimedOut,
		tailOutput: displayTruncation.content,
		llmTailOutput: llmTruncation.content,
		checksPass,
		checksTimedOut,
		checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
		checksDuration,
		parsedMetrics,
		parsedPrimary,
		parsedAsi: parseAsiLines(fullOutput),
		metricName,
		metricUnit,
		fullOutputPath: fullOutputPath ? Option.some(fullOutputPath) : Option.none(),
		truncation,
	};
}

// ------------------------------------------------------------------------------
// Git execution
// ------------------------------------------------------------------------------

type ShellCommandResult = {
	readonly exitCode: number | null;
	readonly output: string;
};

type IsolatedCheckoutFinalizeResult = {
	readonly note: string;
	readonly phaseBaseCommit: string;
	readonly commit: string | null;
};

function makeIsolatedCheckoutPath(workspaceRoot: string, taskId: string): string {
	const digest = createHash("sha256")
		.update(`${workspaceRoot}:${taskId}`)
		.digest("hex")
		.slice(0, 12);
	return path.join(os.tmpdir(), "tau-autoresearch-checkouts", `${taskId}-${digest}`);
}

function makeTaskBranchName(taskId: string): string {
	const suffix = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
	return `tau/autoresearch/${suffix}`;
}

async function runShellCommand(
	ops: BashOperations,
	command: string,
	cwd: string,
	timeoutSeconds: number,
): Promise<ShellCommandResult> {
	let output = "";
	const result = await ops.exec(command, cwd, {
		onData: (data) => {
			output += data.toString("utf-8");
		},
		timeout: timeoutSeconds,
	});
	return {
		exitCode: result.exitCode,
		output: output.trim(),
	};
}

async function runGitOrThrow(
	ops: BashOperations,
	workDir: string,
	command: string,
	action: string,
	timeoutSeconds: number,
): Promise<string> {
	const result = await runShellCommand(ops, command, workDir, timeoutSeconds);
	if (result.exitCode === 0) {
		return result.output;
	}

	const timedOut = result.exitCode === null;
	const reasonSuffix = result.output.length > 0 ? `: ${result.output}` : "";
	throw new AutoresearchGitError({
		reason: timedOut
			? `${action} timed out in ${workDir}${reasonSuffix}`
			: `${action} failed in ${workDir}${reasonSuffix}`,
	});
}

async function resolveGitHeadCommit(ops: BashOperations, workDir: string): Promise<string> {
	const output = await runGitOrThrow(
		ops,
		workDir,
		"git rev-parse --verify HEAD",
		"resolve HEAD commit",
		5,
	);
	const commit = output.trim();
	if (commit.length === 0) {
		throw new AutoresearchGitError({
			reason: `resolve HEAD commit returned empty output for ${workDir}`,
		});
	}
	return commit;
}

function resolveIsolatedScopeWorkDir(checkoutPath: string, scopeRoot: string): string {
	const normalizedRoot = path.normalize(scopeRoot);
	if (path.isAbsolute(normalizedRoot)) {
		throw new AutoresearchValidationError({
			reason: `scope.root must be relative for isolated autoresearch checkout execution. Received: ${scopeRoot}`,
		});
	}

	const resolved = path.resolve(checkoutPath, normalizedRoot);
	const checkoutRoot = path.resolve(checkoutPath);
	if (resolved !== checkoutRoot && !resolved.startsWith(`${checkoutRoot}${path.sep}`)) {
		throw new AutoresearchValidationError({
			reason: `scope.root resolves outside the isolated checkout: ${scopeRoot}`,
		});
	}
	return resolved;
}

async function ensureIsolatedCheckout(
	workspaceRoot: string,
	state: AutoresearchLoopPersistedState,
	ops: BashOperations,
): Promise<IsolatedCheckout> {
	if (Option.isSome(state.autoresearch.isolatedCheckout)) {
		const persisted = state.autoresearch.isolatedCheckout.value;
		if (!fs.existsSync(persisted.checkoutPath)) {
			throw new AutoresearchGitError({
				reason: `isolated checkout path is missing: ${persisted.checkoutPath}`,
			});
		}

		await runGitOrThrow(
			ops,
			persisted.checkoutPath,
			"git rev-parse --is-inside-work-tree",
			"validate isolated checkout repository",
			5,
		);
		await runGitOrThrow(
			ops,
			persisted.checkoutPath,
			`git checkout ${JSON.stringify(persisted.taskBranch)}`,
			"switch isolated checkout branch",
			10,
		);
		await runGitOrThrow(
			ops,
			persisted.checkoutPath,
			`git rev-parse --verify ${JSON.stringify(persisted.phaseBaseCommit)}`,
			"validate isolated checkout phase base commit",
			5,
		);
		return persisted;
	}

	await runGitOrThrow(
		ops,
		workspaceRoot,
		"git rev-parse --is-inside-work-tree",
		"validate workspace repository",
		5,
	);
	const baseCommit = await resolveGitHeadCommit(ops, workspaceRoot);

	const checkoutPath = makeIsolatedCheckoutPath(workspaceRoot, state.taskId);
	if (fs.existsSync(checkoutPath)) {
		const entries = fs.readdirSync(checkoutPath);
		if (entries.length > 0) {
			throw new AutoresearchGitError({
				reason: `isolated checkout path already exists and is not empty: ${checkoutPath}`,
			});
		}
		fs.rmSync(checkoutPath, { recursive: true, force: true });
	}

	await runGitOrThrow(
		ops,
		workspaceRoot,
		`git clone --quiet --no-hardlinks ${JSON.stringify(workspaceRoot)} ${JSON.stringify(checkoutPath)}`,
		"create isolated checkout",
		120,
	);

	const taskBranch = makeTaskBranchName(state.taskId);
	await runGitOrThrow(
		ops,
		checkoutPath,
		`git checkout -B ${JSON.stringify(taskBranch)} ${JSON.stringify(baseCommit)}`,
		"initialize isolated checkout branch",
		20,
	);

	return {
		checkoutPath,
		taskBranch,
		phaseBaseCommit: baseCommit,
	};
}

async function finalizeKeepOnIsolatedCheckout(
	checkout: IsolatedCheckout,
	run: PersistedAutoresearchRun,
	input: {
		readonly description: string;
		readonly status: AutoresearchRunOutcome;
		readonly metrics: Record<string, number> | undefined;
		readonly asi: Record<string, unknown> | null;
	},
	ops: BashOperations,
): Promise<IsolatedCheckoutFinalizeResult> {
	await runGitOrThrow(
		ops,
		checkout.checkoutPath,
		`git checkout ${JSON.stringify(checkout.taskBranch)}`,
		"switch isolated checkout branch",
		10,
	);
	await runGitOrThrow(
		ops,
		checkout.checkoutPath,
		"git add -A",
		"stage isolated checkout changes",
		10,
	);

	const diffResult = await runShellCommand(
		ops,
		"git diff --cached --quiet",
		checkout.checkoutPath,
		10,
	);

	if (diffResult.exitCode === 0) {
		const headCommit = await resolveGitHeadCommit(ops, checkout.checkoutPath);
		return {
			note: `No isolated checkout changes to commit on ${checkout.taskBranch}.`,
			phaseBaseCommit: headCommit,
			commit: null,
		};
	}

	if (diffResult.exitCode !== 1) {
		const reasonSuffix = diffResult.output.length > 0 ? `: ${diffResult.output}` : "";
		throw new AutoresearchGitError({
			reason: `inspect staged isolated checkout changes failed${reasonSuffix}`,
		});
	}

	const resultSummary: Record<string, unknown> = {
		status: input.status,
		run_id: run.runId,
		run_number: run.runNumber,
		phase_id: run.phaseId,
		metrics: input.metrics ?? null,
		asi: input.asi,
	};

	const commitMessage =
		`autoresearch(${run.taskId}) run ${run.runNumber}: ${input.description}\n\n` +
		`result: ${JSON.stringify(resultSummary)}`;
	await runGitOrThrow(
		ops,
		checkout.checkoutPath,
		`git commit -m ${JSON.stringify(commitMessage)}`,
		"commit kept isolated checkout changes",
		20,
	);

	const headCommit = await resolveGitHeadCommit(ops, checkout.checkoutPath);
	return {
		note: `Committed kept changes on ${checkout.taskBranch} at ${headCommit.slice(0, 7)}.`,
		phaseBaseCommit: headCommit,
		commit: headCommit,
	};
}

async function cleanupNonKeepOnIsolatedCheckout(
	checkout: IsolatedCheckout,
	ops: BashOperations,
): Promise<IsolatedCheckoutFinalizeResult> {
	await runGitOrThrow(
		ops,
		checkout.checkoutPath,
		`git checkout ${JSON.stringify(checkout.taskBranch)}`,
		"switch isolated checkout branch",
		10,
	);
	await runGitOrThrow(
		ops,
		checkout.checkoutPath,
		`git reset --hard ${JSON.stringify(checkout.phaseBaseCommit)}`,
		"reset isolated checkout to phase base commit",
		10,
	);
	await runGitOrThrow(
		ops,
		checkout.checkoutPath,
		"git clean -fd",
		"clean isolated checkout untracked files",
		10,
	);

	const headCommit = await resolveGitHeadCommit(ops, checkout.checkoutPath);
	return {
		note: `Reset isolated checkout branch ${checkout.taskBranch} to ${headCommit.slice(0, 7)}.`,
		phaseBaseCommit: headCommit,
		commit: null,
	};
}

// ------------------------------------------------------------------------------
// Response builders
// ------------------------------------------------------------------------------

function buildRunExperimentText(details: RunDetails): string {
	let text = "";
	const benchmarkPassed = details.exitCode === 0 && !details.timedOut;

	if (details.timedOut) {
		text += `TIMEOUT after ${details.durationSeconds.toFixed(1)}s\n`;
	} else if (!benchmarkPassed) {
		text += `FAILED (exit code ${details.exitCode}) in ${details.durationSeconds.toFixed(1)}s\n`;
	} else if (details.checksTimedOut) {
		text += `Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
		text += `CHECKS TIMEOUT (autoresearch.checks.sh) after ${details.checksDuration.toFixed(1)}s\n`;
		text += `Log this as 'checks_failed'\n`;
	} else if (details.checksPass === false) {
		text += `Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
		text += `CHECKS FAILED (autoresearch.checks.sh) in ${details.checksDuration.toFixed(1)}s\n`;
		text += `Log this as 'checks_failed'\n`;
	} else {
		text += `PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
		if (details.checksPass === true) {
			text += `Checks passed in ${details.checksDuration.toFixed(1)}s\n`;
		}
	}

	if (details.parsedMetrics) {
		text += `\nParsed metrics:`;
		if (details.parsedPrimary !== null) {
			text += ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`;
		}
		const secondary = Object.entries(details.parsedMetrics).filter(([k]) => k !== details.metricName);
		for (const [name, value] of secondary) {
			text += ` ${name}=${formatNum(value, "")}`;
		}
		text += `\n`;
	}

	text += `\n${details.llmTailOutput}`;

	if (details.truncation !== null && Option.isSome(details.fullOutputPath)) {
		if (details.truncation.truncatedBy === "lines") {
			text += `\n\n[Showing last ${details.truncation.outputLines} of ${details.truncation.totalLines} lines. Full output: ${details.fullOutputPath.value}]`;
		} else {
			text += `\n\n[Showing last ${details.truncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${details.fullOutputPath.value}]`;
		}
	}

	if (details.checksPass === false && details.checksOutput) {
		text += `\n\nChecks output (last 80 lines):\n${details.checksOutput}`;
	}

	return text;
}
// ------------------------------------------------------------------------------
// Extension
// ------------------------------------------------------------------------------

export default function initAutoresearch(
	pi: ExtensionAPI,
	runEffect: <A, E>(
		effect: Effect.Effect<A, E, LoopEngine | Sandbox | PromptModes>,
	) => Promise<A>,
): void {
	const withLoopEngine = <A, E>(
		f: (service: LoopEngineService) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* LoopEngine;
				return yield* f(service);
			}),
		);

	const getSubagent = (): Promise<boolean> =>
		runEffect(
			Effect.gen(function* () {
				const sandbox = yield* Sandbox;
				const config = yield* sandbox.getConfig;
				return config.subagent;
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

	const captureCurrentExecutionProfile = (
		ctx: Pick<ExtensionContext, "model">,
	): Promise<ExecutionProfile | null> =>
		withPromptModes((promptModes) => promptModes.captureCurrentExecutionProfile(ctx));

	type ActiveAutoresearchChildContext = {
		readonly session: LoopSessionRef;
		readonly loopState: AutoresearchLoopPersistedState;
		readonly controller: LoopSessionRef;
		readonly child: LoopSessionRef;
	};

	const readCanonicalLoopState = (cwd: string, taskId: string): LoopPersistedState => {
		const statePath = path.resolve(cwd, loopStateFile(taskId));
		if (!fs.existsSync(statePath)) {
			throw new LoopTaskNotFoundError({ taskId });
		}
		const content = fs.readFileSync(statePath, "utf-8");
		return decodeLoopPersistedStateJsonSync(content);
	};

	const writeCanonicalLoopState = (cwd: string, state: LoopPersistedState): void => {
		const statePath = path.resolve(cwd, loopStateFile(state.taskId));
		writeAtomicFileSync(statePath, encodeLoopPersistedStateJsonSync(state));
	};

	const loadPhaseSnapshotForState = (
		cwd: string,
		state: AutoresearchLoopPersistedState,
	) => {
		const phaseId = Option.match(state.autoresearch.phaseId, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${state.taskId} has no active phase snapshot. Start or resume the loop first.`,
				});
			},
			onSome: (value) => value,
		});
		const snapshotPath = path.resolve(cwd, loopPhaseFile(state.taskId, phaseId));
		if (!fs.existsSync(snapshotPath)) {
			throw new LoopContractValidationError({
				entity: "loops.phase_snapshot",
				reason: `${loopPhaseFile(state.taskId, phaseId)} does not exist.`,
			});
		}
		const content = fs.readFileSync(snapshotPath, "utf-8");
		return decodeAutoresearchPhaseSnapshotJsonSync(content);
	};

	const resolveActiveAutoresearchChildContext = async (
		ctx: ExtensionContext,
	): Promise<ActiveAutoresearchChildContext> => {
		const session = commandSessionRef(ctx);
		if (Option.isNone(session)) {
			throw new AutoresearchValidationError({
				reason: "Autoresearch run tools require an interactive session file.",
			});
		}

		const owned = await withLoopEngine((engine) =>
			engine.resolveOwnedLoop(ctx.cwd, session.value),
		);
		if (Option.isNone(owned)) {
			throw new AutoresearchValidationError({
				reason: "No loop is owned by the current session.",
			});
		}

		if (owned.value.kind === "blocked_manual_resolution") {
			throw new AutoresearchValidationError({
				reason: `Task ${owned.value.taskId} is blocked for manual resolution: ${owned.value.blocked.message}`,
			});
		}

		const loopState = requireAutoresearchLoopState(owned.value);
		if (loopState.lifecycle !== "active") {
			throw new AutoresearchValidationError({
				reason: `Autoresearch task ${loopState.taskId} is ${loopState.lifecycle}. Start or resume it before running trials.`,
			});
		}

		const controller = Option.match(loopState.ownership.controller, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${loopState.taskId} has no controller session ownership.`,
				});
			},
			onSome: (value) => value,
		});
		const child = Option.match(loopState.ownership.child, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${loopState.taskId} has no active child session. Start the next trial iteration first.`,
				});
			},
			onSome: (value) => value,
		});

		if (!sessionRefMatches(child, session.value)) {
			const fromController = sessionRefMatches(controller, session.value);
			throw new AutoresearchValidationError({
				reason: fromController
					? `Session ${session.value.sessionId} is the controller session for ${loopState.taskId}. autoresearch_run and autoresearch_done are child-session tools only.`
					: `Session ${session.value.sessionId} does not match the active child session for ${loopState.taskId}.`,
			});
		}

		return {
			session: session.value,
			loopState,
			controller,
			child,
		};
	};

	const makeRunId = (runNumber: number): string =>
		`run-${String(runNumber).padStart(4, "0")}-${Date.now()}`;

	const readRunRecord = (cwd: string, taskId: string, runId: string): PersistedAutoresearchRun => {
		const runPath = path.resolve(cwd, loopRunDirectory(taskId, runId), RUN_RECORD_FILE);
		if (!fs.existsSync(runPath)) {
			throw new LoopContractValidationError({
				entity: "loops.run",
				reason: `${path.relative(cwd, runPath)} does not exist.`,
			});
		}
		return parsePersistedRunRecord(fs.readFileSync(runPath, "utf-8"), runPath);
	};

	const writeRunRecord = (cwd: string, run: PersistedAutoresearchRun): void => {
		const runPath = path.resolve(cwd, loopRunDirectory(run.taskId, run.runId), RUN_RECORD_FILE);
		writeAtomicFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
	};

	const autoresearchHelp = () =>
		[
			"Usage: /autoresearch <command>",
			"",
			"Commands:",
			"  create <task-id> [goal]    Create an autoresearch loop task under .pi/loops/tasks/<task-id>.md",
			"  start <task-id>            Start an autoresearch loop",
			"  resume <task-id>           Resume a paused autoresearch loop",
			"  pause [task-id]            Pause an active autoresearch loop",
			"  stop [task-id]             Stop an active or paused autoresearch loop",
			"  status [--archived]        Show autoresearch loops",
			"  archive <task-id>          Archive a stopped autoresearch loop",
			"  cancel <task-id>           Delete a non-active autoresearch loop",
			"  clean [--all]              Remove completed autoresearch loops",
		].join("\n");

	// --------------------------------------------------------------------------
	// Tools
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "autoresearch_run",
		label: "Autoresearch Run",
		description:
			"Execute exactly one autoresearch trial and persist artifacts under .pi/loops/runs/<task-id>/<run-id>/.",
		promptSnippet: "Execute one autoresearch trial and persist run artifacts.",
		promptGuidelines: [
			"Autoresearch loop ownership resolves the active trial context automatically.",
			"Each autoresearch task allows only one pending trial at a time.",
			"Call autoresearch_done after autoresearch_run to finalize the pending trial.",
		],
		parameters: Type.Object({
			timeout: Type.Optional(Type.Number({ description: "Benchmark timeout in seconds (default 600)." })),
			checks_timeout: Type.Optional(
				Type.Number({ description: "Checks timeout in seconds when checks_command is set (default 300)." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let nextStateWritten = false;
			let runDirectoryToCleanup: string | null = null;
			let previousState: AutoresearchLoopPersistedState | null = null;
			let isolatedCheckoutForRecovery: IsolatedCheckout | null = null;

			try {
				const active = await resolveActiveAutoresearchChildContext(ctx);
				const persisted = requireAutoresearchLoopState(
					readCanonicalLoopState(ctx.cwd, active.loopState.taskId),
				);

				if (persisted.lifecycle !== "active") {
					return {
						content: [
							{ type: "text", text: `Error: autoresearch task ${persisted.taskId} is ${persisted.lifecycle}.` },
						],
						details: {},
						isError: true,
					};
				}

				if (Option.isSome(persisted.autoresearch.pendingRunId)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: task ${persisted.taskId} already has pending run ${persisted.autoresearch.pendingRunId.value}. Finalize it with autoresearch_done first.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const existingChildRun = listRunRecordsForTask(ctx.cwd, persisted.taskId).find((run) =>
					sessionRefMatches(run.childSession, active.child),
				);
				if (existingChildRun !== undefined) {
					return {
						content: [
							{
								type: "text",
								text: `Error: child session ${active.child.sessionId} already executed run ${existingChildRun.runId} for task ${persisted.taskId}. Create a new child session for the next trial.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const phaseSnapshot = loadPhaseSnapshotForState(ctx.cwd, persisted);

				const ops = getSandboxedBashOperations(ctx, false);
				if (!ops) {
					throw new AutoresearchValidationError({ reason: "Sandbox bash operations are not available." });
				}

				const isolatedCheckout = await ensureIsolatedCheckout(ctx.cwd, persisted, ops);
				const phaseBaseCommit = await resolveGitHeadCommit(ops, isolatedCheckout.checkoutPath);
				isolatedCheckoutForRecovery = {
					...isolatedCheckout,
					phaseBaseCommit,
				};

				const runNumber = persisted.autoresearch.runCount + 1;
				const runId = makeRunId(runNumber);
				const runDirectory = path.resolve(ctx.cwd, loopRunDirectory(persisted.taskId, runId));
				runDirectoryToCleanup = runDirectory;

				previousState = persisted;
				const now = new Date().toISOString();
				const pendingState: AutoresearchLoopPersistedState = {
					...persisted,
					updatedAt: now,
					autoresearch: {
						...persisted.autoresearch,
						pendingRunId: Option.some(runId),
						runCount: runNumber,
						isolatedCheckout: Option.some(isolatedCheckoutForRecovery),
					},
				};
				writeCanonicalLoopState(ctx.cwd, pendingState);
				nextStateWritten = true;

				fs.mkdirSync(runDirectory, { recursive: true });
				const benchmarkLogPath = path.join(runDirectory, RUN_BENCHMARK_LOG_FILE);
				const checksLogPath = Option.match(phaseSnapshot.benchmark.checksCommand, {
					onNone: () => Option.none<string>(),
					onSome: () => Option.some(path.join(runDirectory, RUN_CHECKS_LOG_FILE)),
				});

				const workDir = resolveIsolatedScopeWorkDir(
					isolatedCheckoutForRecovery.checkoutPath,
					phaseSnapshot.scope.root,
				);
				const details = await executeBenchmarkAsync(
					{
						workDir,
						runDirectory,
						benchmarkLogPath,
						checksLogPath,
						checksCommand: phaseSnapshot.benchmark.checksCommand,
						command: phaseSnapshot.benchmark.command,
						timeoutSeconds: params.timeout ?? 600,
						checksTimeoutSeconds: params.checks_timeout ?? 300,
						metricName: phaseSnapshot.metric.name,
						metricUnit: phaseSnapshot.metric.unit,
						signal,
					},
					onUpdate,
					ops,
				);

				const copiedFullOutput = Option.match(details.fullOutputPath, {
					onNone: () => null,
					onSome: (sourcePath) => {
						const targetPath = path.join(runDirectory, RUN_FULL_OUTPUT_LOG_FILE);
						fs.copyFileSync(sourcePath, targetPath);
						return RUN_FULL_OUTPUT_LOG_FILE;
					},
				});

				const runRecord: PersistedAutoresearchRun = {
					kind: "autoresearch_run",
					version: 1,
					taskId: persisted.taskId,
					runId,
					runNumber,
					phaseId: phaseSnapshot.phaseId,
					createdAt: now,
					childSession: active.child,
					controllerSession: active.controller,
					benchmark: {
						command: phaseSnapshot.benchmark.command,
						durationSeconds: details.durationSeconds,
						exitCode: details.exitCode,
						timedOut: details.timedOut,
						passed: details.passed,
						logFile: RUN_BENCHMARK_LOG_FILE,
						tailOutput: details.llmTailOutput,
					},
					checks: Option.match(phaseSnapshot.benchmark.checksCommand, {
						onNone: () => null,
						onSome: (command) => ({
							command,
							durationSeconds: details.checksDuration,
							passed: details.checksPass,
							timedOut: details.checksTimedOut,
							logFile: Option.isSome(checksLogPath) ? RUN_CHECKS_LOG_FILE : null,
							outputTail: details.checksOutput,
						}),
					}),
					parsed: {
						metricName: details.metricName,
						metricUnit: details.metricUnit,
						metrics: details.parsedMetrics,
						primary: details.parsedPrimary,
						asi: details.parsedAsi,
					},
					fullOutputLogFile: copiedFullOutput,
					finalized: null,
				};
				writeRunRecord(ctx.cwd, runRecord);

				let text = `Run ${runNumber} recorded as pending (${runId}). Finalize with autoresearch_done.\n`;
				text += buildRunExperimentText(details);
				return {
					content: [{ type: "text", text }],
					details: {
						run_id: runId,
						run_number: runNumber,
						task_id: persisted.taskId,
						phase_id: phaseSnapshot.phaseId,
						benchmark_command: phaseSnapshot.benchmark.command,
					},
				};
			} catch (error) {
				if (nextStateWritten && previousState !== null) {
					const recoveredState: AutoresearchLoopPersistedState = {
						...previousState,
						updatedAt: new Date().toISOString(),
						autoresearch: {
							...previousState.autoresearch,
							isolatedCheckout:
								isolatedCheckoutForRecovery === null
									? previousState.autoresearch.isolatedCheckout
									: Option.some(isolatedCheckoutForRecovery),
						},
					};
					writeCanonicalLoopState(ctx.cwd, recoveredState);
				}
				if (runDirectoryToCleanup !== null) {
					fs.rmSync(runDirectoryToCleanup, { recursive: true, force: true });
				}

				if (
					error instanceof AutoresearchValidationError ||
					error instanceof AutoresearchGitError ||
					error instanceof LoopContractValidationError ||
					error instanceof LoopTaskNotFoundError ||
					error instanceof LoopAmbiguousOwnershipError ||
					error instanceof LoopLifecycleConflictError ||
					error instanceof LoopOwnershipValidationError
				) {
					return {
						content: [{ type: "text", text: `Error: ${"reason" in error ? String(error.reason) : String(error)}` }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("autoresearch_run"));
			if (typeof args.timeout === "number") {
				text += theme.fg("dim", ` timeout=${args.timeout}s`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, _theme) {
			const msg = result.content[0];
			return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "autoresearch_done",
		label: "Autoresearch Done",
		description:
			"Finalize the pending autoresearch trial with keep/discard/crash/checks_failed.",
		promptSnippet: "Finalize one pending autoresearch trial.",
		promptGuidelines: [
			"Autoresearch loop ownership resolves the pending trial automatically.",
			"Call this exactly once for each pending autoresearch_run.",
		],
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("keep"),
				Type.Literal("discard"),
				Type.Literal("crash"),
				Type.Literal("checks_failed"),
			]),
			description: Type.String({ description: "Short summary of what this trial proved." }),
			metrics: Type.Optional(Type.Record(Type.String(), Type.Number())),
			asi: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let taskIdForBlock: string | null = null;
			let pendingRunIdForBlock: string | null = null;
			let checkoutPathForBlock: string | null = null;
			let shouldBlockForManualResolution = false;
			try {
				const active = await resolveActiveAutoresearchChildContext(ctx);
				const persisted = requireAutoresearchLoopState(
					readCanonicalLoopState(ctx.cwd, active.loopState.taskId),
				);
				taskIdForBlock = persisted.taskId;

				const pendingRunId = Option.match(persisted.autoresearch.pendingRunId, {
					onNone: () => {
						throw new AutoresearchValidationError({
							reason: `Task ${persisted.taskId} has no pending run. Call autoresearch_run first.`,
						});
					},
					onSome: (value) => value,
				});
				pendingRunIdForBlock = pendingRunId;

				const runRecord = readRunRecord(ctx.cwd, persisted.taskId, pendingRunId);
				if (runRecord.finalized !== null) {
					return {
						content: [{ type: "text", text: `Error: run ${pendingRunId} is already finalized.` }],
						details: {},
						isError: true,
					};
				}
				if (!sessionRefMatches(runRecord.childSession, active.child)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: run ${pendingRunId} belongs to child session ${runRecord.childSession.sessionId}, not ${active.child.sessionId}.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const finalizedAsi = params.asi === undefined ? null : isRecord(params.asi) ? params.asi : null;
				if (params.asi !== undefined && !isRecord(params.asi)) {
					return {
						content: [{ type: "text", text: "Error: asi must be a JSON object when provided." }],
						details: {},
						isError: true,
					};
				}

				const subagent = await getSubagent();
				if (subagent) {
					throw new AutoresearchGitError({
						reason: "Git commands are blocked in subagent mode.",
					});
				}

				const ops = getSandboxedBashOperations(ctx, false);
				if (!ops) {
					throw new AutoresearchGitError({
						reason: "Sandbox bash operations are not available.",
					});
				}

				const persistedCheckout = Option.match(persisted.autoresearch.isolatedCheckout, {
					onNone: () => {
						throw new AutoresearchGitError({
							reason: `Task ${persisted.taskId} has no isolated checkout metadata.`,
						});
					},
					onSome: (value) => value,
				});
				checkoutPathForBlock = persistedCheckout.checkoutPath;
				shouldBlockForManualResolution = true;

				const isolatedCheckout = await ensureIsolatedCheckout(ctx.cwd, persisted, ops);
				checkoutPathForBlock = isolatedCheckout.checkoutPath;

				const vcsResult =
					params.status === "keep"
						? await finalizeKeepOnIsolatedCheckout(
							isolatedCheckout,
							runRecord,
							{
								description: params.description,
								status: params.status,
								metrics: params.metrics,
								asi: finalizedAsi,
							},
							ops,
						)
						: await cleanupNonKeepOnIsolatedCheckout(
							{
								...isolatedCheckout,
								phaseBaseCommit: persistedCheckout.phaseBaseCommit,
							},
							ops,
						);

				const nextIsolatedCheckout: IsolatedCheckout = {
					...isolatedCheckout,
					phaseBaseCommit: vcsResult.phaseBaseCommit,
				};

				const finalizedRun: PersistedAutoresearchRun = {
					...runRecord,
					finalized: {
						status: params.status,
						description: params.description,
						decidedAt: new Date().toISOString(),
						metrics: params.metrics ?? null,
						asi: finalizedAsi,
					},
				};
				writeRunRecord(ctx.cwd, finalizedRun);

				const nextState: AutoresearchLoopPersistedState = {
					...persisted,
					updatedAt: new Date().toISOString(),
					autoresearch: {
						...persisted.autoresearch,
						pendingRunId: Option.none<string>(),
						isolatedCheckout: Option.some(nextIsolatedCheckout),
					},
				};
				writeCanonicalLoopState(ctx.cwd, nextState);

				return {
					content: [
						{
							type: "text",
							text: `Finalized run ${pendingRunId} as ${params.status}. Pending trial cleared for task ${persisted.taskId}. ${vcsResult.note}`,
						},
					],
					details: {
						task_id: persisted.taskId,
						run_id: pendingRunId,
						status: params.status,
						isolated_checkout_path: nextIsolatedCheckout.checkoutPath,
						isolated_branch: nextIsolatedCheckout.taskBranch,
						phase_base_commit: nextIsolatedCheckout.phaseBaseCommit,
						kept_commit: vcsResult.commit,
					},
				};
			} catch (error) {
				if (error instanceof AutoresearchGitError && taskIdForBlock !== null && shouldBlockForManualResolution) {
					const blockTaskId = taskIdForBlock;
					try {
						await withLoopEngine((engine) =>
							engine.blockLoopForManualResolution(ctx.cwd, blockTaskId, {
								reasonCode: "autoresearch.vcs.manual_resolution",
								message: `Autoresearch VCS finalization requires manual resolution: ${error.reason}`,
								recoveryActions: [
									`Inspect isolated checkout state at ${checkoutPathForBlock ?? "(unknown)"}.`,
									`Resolve VCS state manually and then resolve ${loopStateFile(blockTaskId)} before resuming or archiving the task.`,
								],
								recoveryNotes: [
									`pending_run=${pendingRunIdForBlock ?? "unknown"}`,
									`checkout_path=${checkoutPathForBlock ?? "unknown"}`,
								],
							}),
						);
					} catch {
						// keep original error response below
					}

					return {
						content: [
							{
								type: "text",
								text: `Error: ${error.reason}\nTask ${blockTaskId} moved to blocked manual-resolution state for operator recovery.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				if (
					error instanceof AutoresearchValidationError ||
					error instanceof AutoresearchGitError ||
					error instanceof LoopContractValidationError ||
					error instanceof LoopTaskNotFoundError ||
					error instanceof LoopAmbiguousOwnershipError ||
					error instanceof LoopLifecycleConflictError ||
					error instanceof LoopOwnershipValidationError
				) {
					return {
						content: [{ type: "text", text: `Error: ${"reason" in error ? String(error.reason) : String(error)}` }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("autoresearch_done "));
			text += theme.fg("accent", String(args.status));
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, _theme) {
			const msg = result.content[0];
			return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
		},
	});

	// --------------------------------------------------------------------------
	// Command
	// --------------------------------------------------------------------------

	pi.registerCommand("autoresearch", {
		description: "Manage task-scoped autoresearch loops",
		handler: async (args, ctx) => {
			const tokens = tokenizeCommandArgs(args ?? "");
			const command = (tokens[0] ?? "").toLowerCase();
			const rest = tokens.slice(1);

			const requireTaskId = (value: string | undefined, usage: string): string | null => {
				if (!value || value.trim().length === 0) {
					ctx.ui.notify(`Usage: ${usage}`, "warning");
					return null;
				}
				return validateTaskId(value);
			};

			const resolveScopedTaskId = async (): Promise<string | null> => {
				const session = commandSessionRef(ctx);
				if (Option.isNone(session)) {
					ctx.ui.notify("Autoresearch commands require an interactive session file.", "error");
					return null;
				}

				const owned = await withLoopEngine((engine) =>
					engine.resolveOwnedLoop(ctx.cwd, session.value),
				);
				if (Option.isNone(owned) || !isAutoresearchLoopState(owned.value)) {
					ctx.ui.notify("No autoresearch loop is owned by the current session.", "warning");
					return null;
				}
				return owned.value.taskId;
			};

			try {
				if (!command) {
					ctx.ui.notify(autoresearchHelp(), "info");
					return;
				}

					switch (command) {
						case "create": {
							assertNoLegacyAutoresearchLayout(ctx.cwd);
							const taskId = requireTaskId(rest[0], "/autoresearch create <task-id> [goal]");
							if (taskId === null) {
								return;
							}
							const executionProfile = await captureCurrentExecutionProfile(ctx);
							if (executionProfile === null) {
								ctx.ui.notify("Could not capture the current execution profile for this autoresearch task.", "error");
								return;
							}

							const goalText = rest.slice(1).join(" ");
							const taskPath = loopTaskFile(taskId);
							const taskAbsolutePath = path.resolve(ctx.cwd, taskPath);
							const taskContent = fs.existsSync(taskAbsolutePath)
								? fs.readFileSync(taskAbsolutePath, "utf-8")
								: createDefaultTaskDocument(taskId, goalText);
							const contract = parseAutoresearchTaskDocument(taskContent, taskPath);

							await withLoopEngine((engine) =>
								engine.createLoop(ctx.cwd, {
									kind: "autoresearch",
									taskId,
									title: contract.title,
									taskContent: goalText,
									benchmarkCommand: contract.benchmark.command,
									checksCommand: contract.benchmark.checksCommand,
									metricName: contract.metric.name,
									metricUnit: contract.metric.unit,
									metricDirection: contract.metric.direction,
									scopeRoot: contract.scope.root,
									scopePaths: contract.scope.paths,
									offLimits: contract.scope.offLimits,
									constraints: contract.constraints,
									executionProfile,
								}),
							);

							ctx.ui.notify(`Created autoresearch task "${taskId}" at ${taskPath}`, "info");
							return;
						}

					case "start": {
						const taskId = requireTaskId(rest[0], "/autoresearch start <task-id>");
						if (taskId === null) {
							return;
						}
						const session = commandSessionRef(ctx);
						if (Option.isNone(session)) {
							ctx.ui.notify("Autoresearch start requires an interactive session file.", "error");
							return;
						}

						await withLoopEngine((engine) =>
							engine.startLoop(ctx.cwd, taskId, session.value),
						);
						ctx.ui.notify(`Started autoresearch loop "${taskId}"`, "info");
						return;
					}

					case "resume": {
						const taskId = requireTaskId(rest[0], "/autoresearch resume <task-id>");
						if (taskId === null) {
							return;
						}
						const session = commandSessionRef(ctx);
						if (Option.isNone(session)) {
							ctx.ui.notify("Autoresearch resume requires an interactive session file.", "error");
							return;
						}

						await withLoopEngine((engine) =>
							engine.resumeLoop(ctx.cwd, taskId, session.value),
						);
						ctx.ui.notify(`Resumed autoresearch loop "${taskId}"`, "info");
						return;
					}

					case "pause": {
						const taskId = rest[0]
							? requireTaskId(rest[0], "/autoresearch pause [task-id]")
							: await resolveScopedTaskId();
						if (taskId === null) {
							return;
						}
						await withLoopEngine((engine) => engine.pauseLoop(ctx.cwd, taskId));
						ctx.ui.notify(`Paused autoresearch loop "${taskId}"`, "info");
						return;
					}

					case "stop": {
						const taskId = rest[0]
							? requireTaskId(rest[0], "/autoresearch stop [task-id]")
							: await resolveScopedTaskId();
						if (taskId === null) {
							return;
						}
						const persisted = readCanonicalLoopState(ctx.cwd, taskId);
						if (
							persisted.kind === "autoresearch" &&
							Option.isSome(persisted.autoresearch.pendingRunId)
						) {
							ctx.ui.notify(
								`Cannot stop autoresearch loop "${taskId}" while run ${persisted.autoresearch.pendingRunId.value} is pending. Finalize it with autoresearch_done first.`,
								"warning",
							);
							return;
						}
						await withLoopEngine((engine) => engine.stopLoop(ctx.cwd, taskId));
						ctx.ui.notify(`Stopped autoresearch loop "${taskId}"`, "info");
						return;
					}

					case "status": {
						if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--archived")) {
							ctx.ui.notify("Usage: /autoresearch status [--archived]", "warning");
							return;
						}
						const archived = rest[0] === "--archived";
						const loops = await withLoopEngine((engine) =>
							engine.listLoops(ctx.cwd, archived),
						);
						const autoresearchLoops = loops.filter((loop) => isAutoresearchLoopState(loop));
						if (autoresearchLoops.length === 0) {
							ctx.ui.notify(
								archived ? "No archived autoresearch loops." : "No autoresearch loops found.",
								"info",
							);
							return;
						}

						const heading = archived ? "Archived autoresearch loops" : "Autoresearch loops";
						ctx.ui.notify(
							`${heading}:\n${autoresearchLoops.map((loop) => formatAutoresearchLoopState(loop)).join("\n")}`,
							"info",
						);
						return;
					}

					case "archive": {
						const taskId = requireTaskId(rest[0], "/autoresearch archive <task-id>");
						if (taskId === null) {
							return;
						}
						await withLoopEngine((engine) => engine.archiveLoop(ctx.cwd, taskId));
						ctx.ui.notify(`Archived autoresearch loop "${taskId}"`, "info");
						return;
					}

					case "cancel": {
						const taskId = requireTaskId(rest[0], "/autoresearch cancel <task-id>");
						if (taskId === null) {
							return;
						}
						await withLoopEngine((engine) => engine.cancelLoop(ctx.cwd, taskId));
						ctx.ui.notify(`Cancelled autoresearch loop "${taskId}"`, "info");
						return;
					}

					case "clean": {
						if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) {
							ctx.ui.notify("Usage: /autoresearch clean [--all]", "warning");
							return;
						}
						const removeArtifacts = rest[0] === "--all";
						const loops = await withLoopEngine((engine) => engine.listLoops(ctx.cwd, false));
						const completed = loops.filter(
							(loop) => loop.kind === "autoresearch" && loop.lifecycle === "completed",
						);
						if (completed.length === 0) {
							ctx.ui.notify("No completed autoresearch loops to clean.", "info");
							return;
						}
						for (const loop of completed) {
							if (removeArtifacts) {
								await withLoopEngine((engine) => engine.cancelLoop(ctx.cwd, loop.taskId));
								continue;
							}
							fs.rmSync(path.resolve(ctx.cwd, loopStateFile(loop.taskId)), {
								force: true,
							});
						}
						ctx.ui.notify(
							removeArtifacts
								? `Removed ${completed.length} completed autoresearch loop(s).`
								: `Cleaned ${completed.length} completed autoresearch loop state file(s).`,
							"info",
						);
						return;
					}

					default: {
						ctx.ui.notify(autoresearchHelp(), "info");
						return;
					}
				}
			} catch (error) {
				if (error instanceof LoopTaskAlreadyExistsError) {
					ctx.ui.notify(`Autoresearch task "${error.taskId}" already exists.`, "warning");
					return;
				}
				if (error instanceof LoopTaskNotFoundError) {
					ctx.ui.notify(`Autoresearch task "${error.taskId}" not found.`, "error");
					return;
				}
				if (error instanceof LoopLifecycleConflictError) {
					ctx.ui.notify(
						`Lifecycle conflict for "${error.taskId}": expected ${error.expected}, actual ${error.actual}.`,
						"warning",
					);
					return;
				}
				if (error instanceof LoopOwnershipValidationError) {
					ctx.ui.notify(`Ownership error for "${error.taskId}": ${error.reason}`, "error");
					return;
				}
				if (error instanceof LoopAmbiguousOwnershipError) {
					ctx.ui.notify(
						`Ambiguous loop ownership for this session: ${error.matchingTaskIds.join(", ")}`,
						"error",
					);
					return;
				}
				if (error instanceof LoopContractValidationError) {
					ctx.ui.notify(`${error.entity}: ${error.reason}`, "error");
					return;
				}
				throw error;
			}
		},
	});
}
