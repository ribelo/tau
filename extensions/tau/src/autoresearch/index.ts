import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateTail, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import type { TruncationResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { matchesKey, Text } from "@mariozechner/pi-tui";
import { Effect, Option } from "effect";

import { Sandbox } from "../services/sandbox.js";
import { PromptModes } from "../services/prompt-modes.js";
import {
	Autoresearch,
	type AutoresearchExecutionBoundary,
	type AutoresearchService,
	type BenchmarkProgress,
	type ExecuteBenchmarkInput,
	type LogExperimentResult,
	type RunDetails,
} from "../services/autoresearch.js";
import type { ExecutionProfile } from "../execution/schema.js";
import { getSandboxedBashOperations } from "../sandbox/index.js";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
	AutoresearchValidationError,
	AutoresearchGitError,
	AutoresearchBenchmarkCommandMismatchError,
	AutoresearchFingerprintMismatchError,
	AutoresearchMaxExperimentsReachedError,
	AutoresearchNoPendingRunError,
	AutoresearchContractValidationError,
} from "./errors.js";
import { readAutoresearchContractFromContent } from "./contract.js";
import {
	AUTORESEARCH_MD,
	AUTORESEARCH_SH,
	AUTORESEARCH_CHECKS_SH,
	AUTORESEARCH_JSONL,
	AUTORESEARCH_IDEAS_MD,
	AUTORESEARCH_DIR,
} from "./paths.js";
import { resolveWorkDir, resolveMaxExperiments, loadAutoresearchConfig } from "./config.js";
import {
	formatNum,
	formatElapsed,
	parseMetricLines,
	parseAsiLines,
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
} from "./helpers.js";
import {
	renderWidget,
	renderExpandedHeader,
	renderDashboardLines,
	renderOverlayRunningLine,
	renderOverlayFooter,
} from "./dashboard.js";
import { renderRunExperimentResult } from "./run-experiment-render.js";

// ------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function getWorkDir(ctxCwd: string): string {
	const result = loadAutoresearchConfig(ctxCwd);
	if (result.error) {
		throw new Error(result.error);
	}
	return resolveWorkDir(ctxCwd, result.config);
}

function validateWorkDir(ctxCwd: string): string | null {
	const configResult = loadAutoresearchConfig(ctxCwd);
	if (configResult.error) {
		return `Invalid autoresearch.config.json: ${configResult.error}`;
	}
	const workDir = resolveWorkDir(ctxCwd, configResult.config);
	if (workDir === ctxCwd) return null;
	try {
		const stat = fs.statSync(workDir);
		if (!stat.isDirectory()) {
			return `workingDir "${workDir}" (from autoresearch.config.json) is not a directory.`;
		}
	} catch {
		return `workingDir "${workDir}" (from autoresearch.config.json) does not exist.`;
	}
	return null;
}

function getMaxExperiments(ctxCwd: string): number | null {
	const result = loadAutoresearchConfig(ctxCwd);
	if (result.error) {
		throw new Error(result.error);
	}
	return resolveMaxExperiments(result.config);
}

// ------------------------------------------------------------------------------
// Benchmark execution
// ------------------------------------------------------------------------------

async function executeBenchmarkAsync(
	input: ExecuteBenchmarkInput,
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

	const checksShPath = path.join(workDir, AUTORESEARCH_CHECKS_SH);
	if (benchmarkPassed && fs.existsSync(checksShPath)) {
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

		const checksResult = await ops.exec(`bash ${checksShPath}`, workDir, checksOptions);

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

async function runCommitKeep(
	workDir: string,
	experiment: { commit: string; status: string; description: string; metric: number; metrics: Record<string, number> },
	committablePaths: readonly string[],
	ops: BashOperations,
): Promise<{ commit: string; note: string }> {
	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString("utf-8");
	};

	const gitCheck = await ops.exec("git rev-parse --is-inside-work-tree", workDir, { onData, timeout: 5000 });
	if (gitCheck.exitCode !== 0) {
		throw new Error("not inside a git repository");
	}

	output = "";
	const sidecars = new Set([AUTORESEARCH_MD, AUTORESEARCH_SH, AUTORESEARCH_CHECKS_SH]);
	const pathsToStage: string[] = [];
	const missingFilesToCheck: string[] = [];

	for (const p of committablePaths) {
		if (sidecars.has(p)) {
			if (fs.existsSync(path.join(workDir, p))) {
				pathsToStage.push(p);
			}
			continue;
		}
		const fullPath = path.join(workDir, p);
		try {
			fs.statSync(fullPath);
			pathsToStage.push(p);
		} catch {
			missingFilesToCheck.push(p);
		}
	}

	if (missingFilesToCheck.length > 0) {
		let lsOutput = "";
		await ops.exec(
			`git ls-files --error-unmatch ${missingFilesToCheck.map((p) => JSON.stringify(p)).join(" ")}`,
			workDir,
			{ onData: (data) => { lsOutput += data.toString("utf-8"); }, timeout: 5000 },
		);
		const trackedLines = new Set(
			lsOutput
				.trim()
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		);
		for (const p of missingFilesToCheck) {
			if (trackedLines.has(p)) {
				pathsToStage.push(p);
			}
		}
	}

	if (pathsToStage.length > 0) {
		const stageCmd = `git add -- ${pathsToStage.map((p) => JSON.stringify(p)).join(" ")}`;
		const stageResult = await ops.exec(stageCmd, workDir, { onData, timeout: 10000 });
		if (stageResult.exitCode !== 0) {
			throw new Error(`git add failed: ${output.trim()}`);
		}
	}

	output = "";
	const diffResult = await ops.exec("git diff --cached --quiet", workDir, { onData, timeout: 10000 });
	if (diffResult.exitCode === 0) {
		return { commit: experiment.commit, note: "nothing to commit" };
	}

	output = "";
	const resultData: Record<string, unknown> = {
		status: experiment.status,
		metric: experiment.metric,
		...experiment.metrics,
	};
	const trailerJson = JSON.stringify(resultData);
	const commitMsg = `${experiment.description}\n\nResult: ${trailerJson}`;
	const commitResult = await ops.exec(`git commit -m ${JSON.stringify(commitMsg)}`, workDir, { onData, timeout: 10000 });
	if (commitResult.exitCode !== 0) {
		throw new Error(`git commit failed: ${output.trim()}`);
	}

	output = "";
	const shaResult = await ops.exec("git rev-parse --short=7 HEAD", workDir, { onData, timeout: 5000 });
	const sha = shaResult.exitCode === 0 ? output.trim() : experiment.commit;
	return { commit: sha.slice(0, 7), note: `committed ${sha.slice(0, 7)}` };
}

async function runRevertNonKeep(
	workDir: string,
	scopePaths: readonly string[],
	ops: BashOperations,
): Promise<{ note: string }> {
	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString("utf-8");
	};

	const gitCheck = await ops.exec("git rev-parse --is-inside-work-tree", workDir, { onData, timeout: 5000 });
	if (gitCheck.exitCode !== 0) {
		throw new Error("not inside a git repository");
	}

	const pathsToRevert = scopePaths.length > 0 ? scopePaths : ["."];
	const checkoutPaths = pathsToRevert.map((p) => JSON.stringify(p)).join(" ");

	output = "";
	const checkoutResult = await ops.exec(`git checkout -- ${checkoutPaths}`, workDir, { onData, timeout: 10000 });
	if (checkoutResult.exitCode !== 0) {
		throw new Error(`git checkout failed: ${output.trim()}`);
	}

	for (const p of pathsToRevert) {
		await ops.exec(`git clean -fd ${JSON.stringify(p)} 2>/dev/null`, workDir, { onData: () => {}, timeout: 5000 });
	}

	return { note: "reverted changes" };
}

// ------------------------------------------------------------------------------
// Execution boundary factory
// ------------------------------------------------------------------------------

function createExecutionBoundary(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	subagent: boolean,
	applyExecutionProfileInSession: (
		profile: ExecutionProfile,
		ctx: ExtensionContext,
	) => Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }>,
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: BenchmarkProgress }) => void,
	signal?: AbortSignal,
): AutoresearchExecutionBoundary {
	return {
		executeBenchmark: (input) =>
			Effect.gen(function* () {
				const ops = getSandboxedBashOperations(ctx, false);
				if (!ops) {
					return yield* Effect.fail(
						new AutoresearchValidationError({ reason: "Sandbox bash operations are not available." }),
					);
				}
				return yield* Effect.tryPromise({
					try: () => executeBenchmarkAsync({ ...input, signal }, onUpdate, ops),
					catch: (e) => new AutoresearchValidationError({ reason: String(e) }),
				});
			}),

		commitKeep: (workDir, experiment, committablePaths) =>
			Effect.gen(function* () {
				if (subagent) {
					return yield* Effect.fail(
						new AutoresearchGitError({ reason: "Git commands are blocked in subagent mode." }),
					);
				}
				const ops = getSandboxedBashOperations(ctx, false);
				if (!ops) {
					return yield* Effect.fail(
						new AutoresearchGitError({ reason: "Sandbox bash operations are not available." }),
					);
				}
				return yield* Effect.tryPromise({
					try: () => runCommitKeep(workDir, experiment, committablePaths, ops),
					catch: (e) => new AutoresearchGitError({ reason: String(e) }),
				});
			}),

		revertNonKeep: (workDir, scopePaths) =>
			Effect.gen(function* () {
				if (subagent) {
					return yield* Effect.fail(
						new AutoresearchGitError({ reason: "Git commands are blocked in subagent mode." }),
					);
				}
				const ops = getSandboxedBashOperations(ctx, false);
				if (!ops) {
					return yield* Effect.fail(
						new AutoresearchGitError({ reason: "Sandbox bash operations are not available." }),
					);
				}
				return yield* Effect.tryPromise({
					try: () => runRevertNonKeep(workDir, scopePaths, ops),
					catch: (e) => new AutoresearchGitError({ reason: String(e) }),
				});
			}),

		sendFollowUp: (prompt) =>
			Effect.sync(() => {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}),

		applyExecutionProfile: (profile) =>
			Effect.promise(() => applyExecutionProfileInSession(profile, ctx)).pipe(
				Effect.catch((error: unknown) =>
					Effect.succeed({
						applied: false as const,
						reason: String(error),
					}),
				),
			),
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

function currentResults(results: readonly { segment: number }[], segment: number) {
	return results.filter((r) => r.segment === segment);
}

function buildLogExperimentText(result: LogExperimentResult): string {
	const { experiment, state, wallClockSeconds } = result;
	const segmentCount = currentResults(state.results, state.currentSegment).length;

	let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

	if (state.bestMetric !== null) {
		text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
		if (segmentCount > 1 && experiment.status === "keep" && experiment.metric > 0) {
			const delta = experiment.metric - state.bestMetric;
			const pct = ((delta / state.bestMetric) * 100).toFixed(1);
			const sign = delta > 0 ? "+" : "";
			text += ` | this: ${formatNum(experiment.metric, state.metricUnit)} (${sign}${pct}%)`;
		}
	}

	if (Object.keys(experiment.metrics).length > 0) {
		const parts: string[] = [];
		for (const [name, value] of Object.entries(experiment.metrics)) {
			const def = state.secondaryMetrics.find((m) => m.name === name);
			const unit = def?.unit ?? "";
			parts.push(`${name}: ${formatNum(value, unit)}`);
		}
		text += `\nSecondary: ${parts.join("  ")}`;
	}

	if (experiment.asi && Object.keys(experiment.asi).length > 0) {
		const asiParts: string[] = [];
		for (const [k, v] of Object.entries(experiment.asi)) {
			const s = typeof v === "string" ? v : JSON.stringify(v);
			asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "..." : s}`);
		}
		if (asiParts.length > 0) {
			text += `\nASI: ${asiParts.join(" | ")}`;
		}
	}

	if (state.confidence !== null) {
		const confStr = state.confidence.toFixed(1);
		if (state.confidence >= 2.0) {
			text += `\nConfidence: ${confStr}x noise floor — improvement is likely real`;
		} else if (state.confidence >= 1.0) {
			text += `\nConfidence: ${confStr}x noise floor — improvement is above noise but marginal`;
		} else {
			text += `\nConfidence: ${confStr}x noise floor — improvement is within noise`;
		}
	}

	text += `\n(${segmentCount} experiments`;
	if (state.maxExperiments !== null) {
		text += ` / ${state.maxExperiments} max`;
	}
	text += `)`;

	if (result.gitNote) {
		text += `\nGit: ${result.gitNote}`;
	}

	if (wallClockSeconds !== null) {
		text += `\nWall clock: ${wallClockSeconds.toFixed(1)}s`;
	}

	return text;
}

// ------------------------------------------------------------------------------
// Extension
// ------------------------------------------------------------------------------

export default function initAutoresearch(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, Autoresearch | Sandbox | PromptModes>) => Promise<A>,
): void {
	const withAutoresearch = <A, E>(f: (service: AutoresearchService) => Effect.Effect<A, E, never>): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
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

	const applyExecutionProfileInSession = (
		profile: ExecutionProfile,
		ctx: ExtensionContext,
	): Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }> =>
		withPromptModes((promptModes) =>
			promptModes.applyExecutionProfile(profile, ctx, {
				notifyOnSuccess: false,
				persist: false,
				ephemeral: true,
			}).pipe(
				Effect.map((result) =>
					result.applied
						? ({ applied: true } as const)
						: ({ applied: false, reason: result.reason } as const),
				),
			),
		);

	const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

	const autoresearchHelp = () =>
		[
			"Usage: /autoresearch [off|clear|<text>]",
			"",
			"<text> enters autoresearch mode and starts or resumes the loop.",
			"off leaves autoresearch mode.",
			"clear deletes autoresearch.jsonl and turns autoresearch mode off.",
		].join("\n");

	const expandedState = new Map<string, boolean>();
	const latestViewData = new Map<string, import("../services/autoresearch.js").AutoresearchViewData>();
	type OverlayState = {
		tui: import("@mariozechner/pi-tui").TUI;
		done: () => void;
		spinnerTimer?: ReturnType<typeof setInterval>;
		spinnerFrame: number;
	};
	const overlayStates = new Map<string, OverlayState>();

	const requestOverlayRender = (sessionId: string): void => {
		const state = overlayStates.get(sessionId);
		if (state) {
			state.tui.invalidate();
		}
	};

	const closeFullscreenOverlay = (sessionId: string): void => {
		const state = overlayStates.get(sessionId);
		if (state) {
			state.done();
			if (state.spinnerTimer) clearInterval(state.spinnerTimer);
			overlayStates.delete(sessionId);
		}
	};

	const updateUI = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;

		const sessionId = getSessionKey(ctx);
		const viewData = await withAutoresearch((service) => service.getViewData(sessionId));
		latestViewData.set(sessionId, viewData);
		requestOverlayRender(sessionId);

		if (viewData.totalRunCount === 0 && !viewData.runningExperiment) {
			ctx.ui.setWidget("autoresearch", undefined);
			return;
		}

		const expanded = expandedState.get(sessionId) ?? false;

		ctx.ui.setWidget("autoresearch", (_tui, theme) => {
			const width = process.stdout.columns ?? 120;
			return new Text(renderWidget(viewData, width, theme, expanded), 0, 0);
		});
	};

	const openFullscreenOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		const sessionId = getSessionKey(ctx);
		const viewData = latestViewData.get(sessionId);
		if (!viewData) return;
		if (viewData.totalRunCount === 0 && !viewData.runningExperiment) {
			ctx.ui.notify("No autoresearch results yet", "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const state: OverlayState = { tui, done, spinnerFrame: 0 };
				state.spinnerTimer = setInterval(() => {
					state.spinnerFrame += 1;
					tui.invalidate();
				}, 80);
				overlayStates.set(sessionId, state);

				let scrollOffset = 0;
				return {
					render(width: number): string[] {
						const currentView = latestViewData.get(sessionId);
						if (!currentView) {
							done();
							return [];
						}
						const terminalRows = process.stdout.rows ?? 40;
						const header = renderExpandedHeader(currentView, width, theme);
						const body = renderDashboardLines(currentView, width, theme, 0);
						if (currentView.runningExperiment) {
							body.push(renderOverlayRunningLine(currentView, theme, width, state.spinnerFrame));
						}
						const viewportRows = Math.max(4, terminalRows - 4);
						const maxScroll = Math.max(0, body.length - viewportRows);
						if (scrollOffset > maxScroll) scrollOffset = maxScroll;
						const visible = body.slice(scrollOffset, scrollOffset + viewportRows);
						const footer = renderOverlayFooter(width, scrollOffset, viewportRows, body.length, theme);
						return [
							header,
							...visible,
							...Array.from({ length: Math.max(0, viewportRows - visible.length) }, () => ""),
							footer,
						];
					},
					handleInput(data: string): void {
						const currentView = latestViewData.get(sessionId);
						const totalRows =
							(currentView
								? renderDashboardLines(currentView, process.stdout.columns ?? 120, theme, 0).length +
								  (currentView.runningExperiment ? 1 : 0)
								: 0);
						const terminalRows = process.stdout.rows ?? 40;
						const viewportRows = Math.max(4, terminalRows - 4);
						const maxScroll = Math.max(0, totalRows - viewportRows);
						if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
							done();
							return;
						}
						if (matchesKey(data, "up") || data === "k") {
							scrollOffset = Math.max(0, scrollOffset - 1);
						} else if (matchesKey(data, "down") || data === "j") {
							scrollOffset = Math.min(maxScroll, scrollOffset + 1);
						} else if (matchesKey(data, "pageUp") || data === "u") {
							scrollOffset = Math.max(0, scrollOffset - viewportRows);
						} else if (matchesKey(data, "pageDown") || data === "d") {
							scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
						} else if (data === "g") {
							scrollOffset = 0;
						} else if (data === "G") {
							scrollOffset = maxScroll;
						}
						tui.invalidate();
					},
					invalidate(): void {},
					dispose(): void {
						if (state.spinnerTimer) clearInterval(state.spinnerTimer);
						overlayStates.delete(sessionId);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
			},
		);
	};

	const rehydrate = async (ctx: ExtensionContext) => {
		const sessionId = getSessionKey(ctx);
		let workDir: string;
		try {
			workDir = getWorkDir(ctx.cwd);
		} catch {
			return;
		}
		await withAutoresearch((service) => service.rehydrate(sessionId, workDir));
		await updateUI(ctx);
	};

	// --------------------------------------------------------------------------
	// Tools
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "init_experiment",
		label: "Init Experiment",
		description:
			"Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to autoresearch.jsonl.",
		promptSnippet: "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
		promptGuidelines: [
			"Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
			"If autoresearch.jsonl already exists with a config, do NOT call init_experiment again.",
			"If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
		],
		parameters: Type.Object({
			name: Type.String({
				description:
					'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
			}),
			metric_name: Type.String({
				description:
					'Display name for the primary metric (e.g. "total_us", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
			}),
			metric_unit: Type.Optional(
				Type.String({
					description:
						'Unit for the primary metric. Use "us", "ms", "s", "kb", "mb", or "" for unitless. Default: ""',
				}),
			),
			direction: Type.Optional(
				Type.String({
					description: 'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workDirError = validateWorkDir(ctx.cwd);
			if (workDirError) {
				return {
					content: [{ type: "text", text: `Error: ${workDirError}` }],
					details: {},
				};
			}
			const workDir = getWorkDir(ctx.cwd);
			const maxExperiments = getMaxExperiments(ctx.cwd);
			const sessionId = getSessionKey(ctx);
			const executionProfile = await captureCurrentExecutionProfile(ctx);
			if (executionProfile === null) {
				return {
					content: [
						{
							type: "text",
							text: "Error: could not capture the current execution profile. Set /mode and retry init_experiment.",
						},
					],
					details: {},
					isError: true,
				};
			}

			let contractContent: string;
			try {
				contractContent = fs.readFileSync(path.join(workDir, AUTORESEARCH_MD), "utf-8");
			} catch {
				return {
					content: [{ type: "text", text: `Error: ${AUTORESEARCH_MD} does not exist. Create it before initializing autoresearch.` }],
					details: {},
					isError: true,
				};
			}
			const contractResult = readAutoresearchContractFromContent(contractContent, path.join(workDir, AUTORESEARCH_MD));
			if (contractResult.errors.length > 0) {
				return {
					content: [{ type: "text", text: `Error: ${contractResult.errors.join(" ")}` }],
					details: {},
					isError: true,
				};
			}

			try {
				const result = await withAutoresearch((service) =>
					service.initExperiment(sessionId, workDir, {
						name: params.name,
						metricName: params.metric_name,
						metricUnit: params.metric_unit ?? "",
						direction: params.direction === "higher" ? "higher" : "lower",
						benchmarkCommand: contractResult.contract.benchmark.command ?? "bash autoresearch.sh",
						scopePaths: contractResult.contract.scopePaths,
						offLimits: contractResult.contract.offLimits,
						constraints: contractResult.contract.constraints,
						executionProfile,
						maxExperiments,
					}),
				);
				await updateUI(ctx);

				const reinitNote = result.isReinitializing
					? " (re-initialized — previous results archived, new baseline needed)"
					: "";
				const limitNote =
					maxExperiments !== null ? `\nMax iterations: ${maxExperiments} (from autoresearch.config.json)` : "";
				const workDirNote = workDir !== ctx.cwd ? `\nWorking directory: ${workDir}` : "";
				return {
					content: [
						{
							type: "text",
							text: `Experiment initialized: "${result.name}"${reinitNote}\nMetric: ${result.metricName} (${result.metricUnit || "unitless"}, ${result.direction} is better)${limitNote}${workDirNote}\nConfig written to autoresearch.jsonl. Now run the baseline with run_experiment.`,
						},
					],
					details: {},
				};
			} catch (error) {
				if (error instanceof AutoresearchValidationError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchBenchmarkCommandMismatchError) {
					return {
						content: [
							{
								type: "text",
								text: `Error: benchmark command mismatch. Expected: ${error.expected}, Received: ${error.received}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchFingerprintMismatchError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchContractValidationError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("init_experiment "));
			text += theme.fg("accent", (args.name as string) ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "run_experiment",
		label: "Run Experiment",
		description:
			"Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Use for any autoresearch experiment.",
		promptSnippet: "Run a timed experiment command (captures duration, output, exit code)",
		promptGuidelines: [
			"Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
			"After run_experiment, always call log_experiment to record the result.",
			"If the benchmark script outputs structured METRIC lines, run_experiment will parse them automatically.",
		],
		parameters: Type.Object({
			command: Type.String({
				description: "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
			}),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const workDirError = validateWorkDir(ctx.cwd);
			if (workDirError) {
				return {
					content: [{ type: "text", text: `Error: ${workDirError}` }],
					details: {},
				};
			}
			const workDir = getWorkDir(ctx.cwd);
			const sessionId = getSessionKey(ctx);
			const subagent = await getSubagent();
			const boundary = createExecutionBoundary(
				pi,
				ctx,
				subagent,
				applyExecutionProfileInSession,
				onUpdate,
				signal,
			);
			const usage = ctx.getContextUsage();
			const contextUsage =
				usage && usage.tokens !== null
					? { tokens: usage.tokens, contextWindow: usage.contextWindow }
					: undefined;

			try {
				const details = await withAutoresearch((service) =>
					service.runExperiment(
						sessionId,
						workDir,
						{
							command: params.command,
							timeoutSeconds: params.timeout ?? 600,
							checksTimeoutSeconds: 300,
							contextUsage,
						},
						boundary,
					),
				);
				await updateUI(ctx);
				return {
					content: [{ type: "text", text: buildRunExperimentText(details) }],
					details: { ...details },
				};
			} catch (error) {
				if (error instanceof AutoresearchValidationError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchFingerprintMismatchError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchMaxExperimentsReachedError) {
					return {
						content: [
							{
								type: "text",
								text: `Maximum experiments reached (${error.maxExperiments}). Call init_experiment to start a new segment.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("run_experiment "));
			text += theme.fg("muted", (args.command as string) ?? "");
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme) {
			return renderRunExperimentResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "log_experiment",
		label: "Log Experiment",
		description:
			"Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
		promptSnippet: "Log experiment result (commit, metric, status, description)",
		promptGuidelines: [
			"Always call log_experiment after run_experiment to record the result.",
			"log_experiment automatically commits on 'keep', and reverts on 'discard'/'crash'/'checks_failed'.",
			"Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}.",
		],
		parameters: Type.Object({
			commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
			metric: Type.Number({
				description: "The primary optimization metric value. 0 for crashes.",
			}),
			status: Type.String({ description: "keep, discard, crash, or checks_failed" }),
			description: Type.String({ description: "Short description of what this experiment tried" }),
			metrics: Type.Optional(Type.Record(Type.String(), Type.Number())),
			force: Type.Optional(Type.Boolean()),
			asi: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workDirError = validateWorkDir(ctx.cwd);
			if (workDirError) {
				return {
					content: [{ type: "text", text: `Error: ${workDirError}` }],
					details: {},
				};
			}
			const workDir = getWorkDir(ctx.cwd);
			const sessionId = getSessionKey(ctx);
			const subagent = await getSubagent();
			const boundary = createExecutionBoundary(pi, ctx, subagent, applyExecutionProfileInSession);

			const status = params.status as "keep" | "discard" | "crash" | "checks_failed";
			if (!["keep", "discard", "crash", "checks_failed"].includes(status)) {
				return {
					content: [{ type: "text", text: `Error: invalid status "${status}"` }],
					details: {},
					isError: true,
				};
			}

			try {
				const result = await withAutoresearch((service) =>
					service.logExperiment(
						sessionId,
						workDir,
						{
							commit: params.commit,
							metric: params.metric,
							status,
							description: params.description,
							metrics: params.metrics ?? undefined,
							force: params.force ?? false,
							asi: (params.asi ?? undefined) as Record<string, unknown> | undefined,
						},
						boundary,
					),
				);
				await updateUI(ctx);
				return {
					content: [{ type: "text", text: buildLogExperimentText(result) }],
					details: {},
				};
			} catch (error) {
				if (error instanceof AutoresearchValidationError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchFingerprintMismatchError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchNoPendingRunError) {
					return {
						content: [{ type: "text", text: `Error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				if (error instanceof AutoresearchGitError) {
					return {
						content: [{ type: "text", text: `Git error: ${error.reason}` }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("log_experiment "));
			const color =
				args.status === "keep"
					? "success"
					: args.status === "crash" || args.status === "checks_failed"
						? "error"
						: "warning";
			text += theme.fg(color, String(args.status));
			text += " " + theme.fg("dim", String(args.description));
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
		},
	});

	// --------------------------------------------------------------------------
	// Command
	// --------------------------------------------------------------------------

	pi.registerCommand("autoresearch", {
		description: "Start, stop, clear, or resume autoresearch mode",
		handler: async (args, ctx) => {
			const sessionId = getSessionKey(ctx);
			const trimmedArgs = (args ?? "").trim();
			const command = trimmedArgs.toLowerCase();

			if (!trimmedArgs) {
				ctx.ui.notify(autoresearchHelp(), "info");
				return;
			}

			if (command === "off") {
				await withAutoresearch((service) => service.setMode(sessionId, false, null));
				ctx.ui.notify("Autoresearch mode OFF", "info");
				await updateUI(ctx);
				return;
			}

			if (command === "clear") {
				await withAutoresearch((service) =>
					Effect.gen(function* () {
						yield* service.clearSession(sessionId);
						yield* service.setMode(sessionId, false, null);
					}),
				);
				let workDir: string;
				try {
					workDir = getWorkDir(ctx.cwd);
				} catch (error) {
					ctx.ui.notify(`Invalid autoresearch.config.json: ${String(error)}`, "error");
					return;
				}
				const jsonlPath = path.join(workDir, AUTORESEARCH_JSONL);
				const runsDir = path.join(workDir, AUTORESEARCH_DIR, "runs");
				try {
					if (fs.existsSync(jsonlPath)) {
						fs.unlinkSync(jsonlPath);
					}
				} catch {
					// ignore
				}
				try {
					if (fs.existsSync(runsDir)) {
						fs.rmSync(runsDir, { recursive: true, force: true });
					}
				} catch {
					// ignore
				}
				ctx.ui.notify("Deleted autoresearch.jsonl and turned autoresearch mode OFF", "info");
				await updateUI(ctx);
				return;
			}

			const isActive = await withAutoresearch((service) =>
				service.getViewData(sessionId).pipe(Effect.map((v) => v.autoresearchMode)),
			);

			if (isActive) {
				ctx.ui.notify("Autoresearch already active — use '/autoresearch off' to stop first", "info");
				return;
			}

			await withAutoresearch((service) => service.setMode(sessionId, true, trimmedArgs));

			let workDir: string;
			try {
				workDir = getWorkDir(ctx.cwd);
			} catch (error) {
				await withAutoresearch((service) => service.setMode(sessionId, false, null));
				ctx.ui.notify(`Invalid autoresearch.config.json: ${String(error)}`, "error");
				return;
			}
			const mdPath = path.join(workDir, AUTORESEARCH_MD);
			const hasRules = fs.existsSync(mdPath);

			if (hasRules) {
				ctx.ui.notify("Autoresearch mode ON — rules loaded from autoresearch.md", "info");
				pi.sendUserMessage(`Autoresearch mode active. ${trimmedArgs}`);
			} else {
				ctx.ui.notify("Autoresearch mode ON — no autoresearch.md found, setting up", "info");
				pi.sendUserMessage(`Start autoresearch: ${trimmedArgs}`);
			}
			await updateUI(ctx);
		},
	});

	// --------------------------------------------------------------------------
	// Shortcuts
	// --------------------------------------------------------------------------

	pi.registerShortcut("ctrl+x", {
		description: "Toggle autoresearch dashboard",
		handler(ctx): void {
			const sessionId = getSessionKey(ctx);
			const viewData = latestViewData.get(sessionId);
			if (!viewData || (viewData.totalRunCount === 0 && !viewData.runningExperiment)) {
				ctx.ui.notify("No autoresearch results yet", "info");
				return;
			}
			expandedState.set(sessionId, !expandedState.get(sessionId));
			void updateUI(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+x", {
		description: "Show autoresearch dashboard overlay",
		handler(ctx): Promise<void> {
			return openFullscreenOverlay(ctx);
		},
	});

	// --------------------------------------------------------------------------
	// Lifecycle hooks
	// --------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		await rehydrate(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await rehydrate(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await rehydrate(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await rehydrate(ctx);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		const sessionId = getSessionKey(ctx);
		closeFullscreenOverlay(sessionId);
	});

	pi.on("agent_start", async (_event, ctx) => {
		const sessionId = getSessionKey(ctx);
		await withAutoresearch((service) => service.resetSessionCounters(sessionId));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionId = getSessionKey(ctx);
		const isActive = await withAutoresearch((service) =>
			service.getViewData(sessionId).pipe(Effect.map((v) => v.autoresearchMode)),
		);
		if (!isActive) return;

		const pinnedExecutionProfile = await withAutoresearch((service) =>
			service.getExecutionProfile(sessionId),
		);
		if (pinnedExecutionProfile === null) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Autoresearch segment has no pinned execution profile. Re-run init_experiment before continuing.",
					"error",
				);
			}
			return;
		}

		const appliedExecutionProfile = await applyExecutionProfileInSession(
			pinnedExecutionProfile,
			ctx,
		);
		if (!appliedExecutionProfile.applied) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Autoresearch could not apply pinned execution profile: ${appliedExecutionProfile.reason}`,
					"error",
				);
			}
			return;
		}

		let workDir: string;
		try {
			workDir = getWorkDir(ctx.cwd);
		} catch {
			return;
		}
		const mdPath = path.join(workDir, AUTORESEARCH_MD);
		const ideasPath = path.join(workDir, AUTORESEARCH_IDEAS_MD);
		const checksPath = path.join(workDir, AUTORESEARCH_CHECKS_SH);
		const hasIdeas = fs.existsSync(ideasPath);
		const hasChecks = fs.existsSync(checksPath);

		let extra =
			"\n\n## Autoresearch Mode (ACTIVE)" +
			"\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
			"\nUse init_experiment, run_experiment, and log_experiment tools." +
			`\nExperiment rules: ${mdPath} — read this file at the start of every session.` +
			"\nWrite promising but deferred optimizations as bullet points to autoresearch.ideas.md.";

		if (hasChecks) {
			extra +=
				"\n\n## Backpressure Checks (ACTIVE)" +
				`\n${checksPath} exists and runs automatically after every passing benchmark.` +
				"\nIf checks fail, use status 'checks_failed' in log_experiment.";
		}

		if (hasIdeas) {
			extra += `\n\nIdeas backlog exists at ${ideasPath}.`;
		}

		return {
			systemPrompt: event.systemPrompt + extra,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		const sessionId = getSessionKey(ctx);
		let workDir: string;
		try {
			workDir = getWorkDir(ctx.cwd);
		} catch {
			return;
		}
		const subagent = await getSubagent();
		const boundary = createExecutionBoundary(pi, ctx, subagent, applyExecutionProfileInSession);
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? null;

		try {
			const result = await withAutoresearch((service) =>
				service.onAgentEnd(sessionId, workDir, boundary),
			);
			if (result.didResume) {
				const ideasPath = path.join(workDir, AUTORESEARCH_IDEAS_MD);
				const hasIdeas = fs.existsSync(ideasPath);
				let msg = "Autoresearch loop ended. Resume the experiment loop.";
				if (hasIdeas) {
					msg += " Check autoresearch.ideas.md for promising paths.";
				}
				pi.sendUserMessage(msg);
			} else if (result.blockedReason !== null && ctx.hasUI) {
				ctx.ui.notify(`Autoresearch auto-resume blocked: ${result.blockedReason}`, "error");
			}
		} catch {
			// ignore
		} finally {
			await withAutoresearch((service) => service.recordAgentEndTokens(sessionId, tokens));
			await updateUI(ctx);
		}
	});
}
