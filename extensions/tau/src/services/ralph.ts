import * as path from "node:path";

import { Clock, Deferred, Effect, Layer, Option, Ref, ServiceMap } from "effect";
import type { AgentEndEvent } from "@mariozechner/pi-coding-agent";

import type { ExecutionProfile } from "../execution/schema.js";
import {
	LoopAmbiguousOwnershipError,
	LoopContractValidationError,
	LoopLifecycleConflictError,
	LoopOwnershipValidationError,
	LoopTaskAlreadyExistsError,
	LoopTaskNotFoundError,
	type LoopEngineError,
} from "../loops/errors.js";
import type { LoopSessionRef } from "../loops/schema.js";
import { RalphRepo } from "../ralph/repo.js";
import { RALPH_TASKS_DIR } from "../ralph/paths.js";
import { RalphContractValidationError } from "../ralph/errors.js";
import type { LoopState } from "../ralph/schema.js";
import { LoopEngine } from "./loop-engine.js";

export const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

type LoopStepResult =
	| {
			readonly _tag: "continue";
	  }
	| {
			readonly _tag: "blocked";
			readonly message: string;
	  }
	| {
			readonly _tag: "stopped";
			readonly message: Option.Option<string>;
			readonly banner: Option.Option<string>;
	  };

const continueLoop: LoopStepResult = { _tag: "continue" };

export type RalphRunLoopResult = {
	readonly status: "blocked" | "stopped";
	readonly message: Option.Option<string>;
	readonly banner: Option.Option<string>;
};

export type RalphDoneResult = {
	readonly text: string;
};

export type RalphAgentEndResult = {
	readonly consumedByWaitingLoop: boolean;
	readonly banner: Option.Option<string>;
};

export type RalphStartLoopInput = {
	readonly loopName: string;
	readonly taskFile: string;
	readonly executionProfile: ExecutionProfile;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
	readonly controllerSessionFile: Option.Option<string>;
	readonly defaultTaskTemplate: string;
};

export type RalphStartLoopStateResult =
	| {
			readonly status: "started";
			readonly loopName: string;
			readonly taskFile: string;
			readonly createdTask: boolean;
			readonly maxIterations: number;
	  }
	| {
			readonly status: "already_active";
			readonly loopName: string;
	  }
	| {
			readonly status: "missing_controller_session";
	  };

export type RalphPrepareLoopTaskInput = {
	readonly loopName: string;
	readonly taskContent: string;
};

export type RalphPrepareLoopTaskResult =
	| {
			readonly status: "prepared";
			readonly taskFile: string;
	  }
	| {
			readonly status: "already_active";
			readonly loopName: string;
	  };

export type RalphPauseCurrentLoopResult =
	| {
			readonly status: "paused";
			readonly loopName: string;
			readonly iteration: number;
	  }
	| {
			readonly status: "no_active_loop";
	  }
	| {
			readonly status: "missing_current_loop_state";
	  };

export type RalphStopLoopResult =
	| {
			readonly status: "stopped";
			readonly loopName: string;
			readonly iteration: number;
	  }
	| {
			readonly status: "no_active_loop";
	  }
	| {
			readonly status: "not_active";
			readonly loopName: string;
	  };

export type RalphResumeLoopStateResult =
	| {
			readonly status: "resumed";
			readonly loopName: string;
	  }
	| {
			readonly status: "not_found";
	  }
	| {
			readonly status: "completed";
	  };

export type RalphCancelLoopResult =
	| {
			readonly status: "cancelled";
	  }
	| {
			readonly status: "not_found";
	  };

export type RalphArchiveLoopByNameResult =
	| {
			readonly status: "archived";
	  }
	| {
			readonly status: "not_found";
	  }
	| {
			readonly status: "active_loop";
	  };

export type RalphCleanCompletedLoopsResult = {
	readonly cleanedLoops: ReadonlyArray<string>;
};

export type RalphNukeLoopsResult = {
	readonly removed: boolean;
};

export type RalphCommandBoundary = {
	readonly cwd: string;
	readonly getSessionFile: () => string | undefined;
	readonly switchSession: (targetSessionFile: string) => Effect.Effect<{ readonly cancelled: boolean }, never, never>;
	readonly newSession: (
		options: {
			readonly parentSession: string;
		},
	) => Effect.Effect<{ readonly cancelled: boolean }, never, never>;
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
	) => Effect.Effect<{ readonly applied: boolean; readonly reason?: string }, never, never>;
	readonly sendFollowUp: (prompt: string) => Effect.Effect<void, never, never>;
};

export interface RalphLiveConfig {
	readonly hasActiveSubagents: () => Effect.Effect<boolean, never, never>;
}

type PendingAgentEndWait = {
	readonly deferred: Deferred.Deferred<AgentEndEvent>;
	readonly iterationSessionFile: string;
};

const extractLastAssistantText = (event: AgentEndEvent): string => {
	const lastAssistant = [...event.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (!lastAssistant || !Array.isArray(lastAssistant.content)) {
		return "";
	}
	return lastAssistant.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
};

const optionContains = (option: Option.Option<string>, value: string | undefined): boolean => {
	if (value === undefined) {
		return false;
	}
	return Option.match(option, {
		onNone: () => false,
		onSome: (optionValue) => optionValue === value,
	});
};

const toContractError = (entity: string, reason: string): RalphContractValidationError =>
	new RalphContractValidationError({
		entity,
		reason,
	});

const loopEngineErrorToContract = (
	error: LoopEngineError,
): RalphContractValidationError => {
	if (error instanceof LoopContractValidationError) {
		return toContractError(error.entity, error.reason);
	}
	if (error instanceof LoopTaskNotFoundError) {
		return toContractError("loops.state", `task "${error.taskId}" not found`);
	}
	if (error instanceof LoopTaskAlreadyExistsError) {
		return toContractError("loops.state", `task "${error.taskId}" already exists`);
	}
	if (error instanceof LoopLifecycleConflictError) {
		return toContractError(
			"loops.lifecycle",
			`task "${error.taskId}" expected ${error.expected}, got ${error.actual}`,
		);
	}
	if (error instanceof LoopOwnershipValidationError) {
		return toContractError("loops.ownership", error.reason);
	}
	if (error instanceof LoopAmbiguousOwnershipError) {
		return toContractError(
			"loops.ownership",
			`session ${error.sessionFile} matches multiple loops: ${error.matchingTaskIds.join(", ")}`,
		);
	}
	return toContractError("loops.engine", String(error));
};

const mapLoopEngineError = <A>(
	effect: Effect.Effect<A, LoopEngineError, never>,
): Effect.Effect<A, RalphContractValidationError, never> =>
	effect.pipe(Effect.mapError(loopEngineErrorToContract));

const sessionRefFromFile = (sessionFile: string): LoopSessionRef => ({
	sessionId: sessionFile,
	sessionFile,
});

const nowIso = Effect.gen(function* () {
	const millis = yield* Clock.currentTimeMillis;
	return new Date(millis).toISOString();
});

function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
	const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
	const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

	const parts = [header, ""];
	if (isReflection) {
		parts.push(state.reflectInstructions, "\n---\n");
	}

	parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
	parts.push(`\n## Instructions\n`);
	parts.push("User controls: ESC pauses the assistant. Run /ralph pause to keep the loop resumable. Run /ralph stop when idle to end the loop.\n");
	parts.push(
		`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
	);

	if (state.itemsPerIteration > 0) {
		parts.push(
			`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`,
		);
		parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
	} else {
		parts.push(`1. Continue working on the task`);
	}

	parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
	parts.push(`3. When FULLY COMPLETE, respond with: ${COMPLETE_MARKER}`);
	parts.push(`4. Otherwise, call the ralph_done tool to proceed to next iteration`);

	return parts.join("\n");
}

export interface RalphService {
	readonly startLoopState: (
		cwd: string,
		input: RalphStartLoopInput,
	) => Effect.Effect<RalphStartLoopStateResult, RalphContractValidationError, never>;
	readonly prepareLoopTask: (
		cwd: string,
		input: RalphPrepareLoopTaskInput,
	) => Effect.Effect<RalphPrepareLoopTaskResult, RalphContractValidationError, never>;
	readonly listLoops: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<LoopState>, RalphContractValidationError, never>;
	readonly findLoopBySessionFile: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<Option.Option<LoopState>, RalphContractValidationError, never>;
	readonly resolveLoopForUi: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<Option.Option<LoopState>, RalphContractValidationError, never>;
	readonly pauseCurrentLoop: (
		cwd: string,
	) => Effect.Effect<RalphPauseCurrentLoopResult, RalphContractValidationError, never>;
	readonly stopActiveLoop: (
		cwd: string,
	) => Effect.Effect<RalphStopLoopResult, RalphContractValidationError, never>;
	readonly resumeLoopState: (
		cwd: string,
		loopName: string,
	) => Effect.Effect<RalphResumeLoopStateResult, RalphContractValidationError, never>;
	readonly cancelLoop: (
		cwd: string,
		loopName: string,
	) => Effect.Effect<RalphCancelLoopResult, RalphContractValidationError, never>;
	readonly archiveLoopByName: (
		cwd: string,
		loopName: string,
	) => Effect.Effect<RalphArchiveLoopByNameResult, RalphContractValidationError, never>;
	readonly cleanCompletedLoops: (
		cwd: string,
		all: boolean,
	) => Effect.Effect<RalphCleanCompletedLoopsResult, RalphContractValidationError, never>;
	readonly nukeLoops: (
		cwd: string,
	) => Effect.Effect<RalphNukeLoopsResult, RalphContractValidationError, never>;
	readonly syncCurrentLoopFromSession: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<void, RalphContractValidationError, never>;
	readonly existsRalphDirectory: (cwd: string) => Effect.Effect<boolean, never, never>;
	readonly persistOwnedLoopOnShutdown: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<void, RalphContractValidationError, never>;
	readonly runLoop: (
		boundary: RalphCommandBoundary,
		loopName: string,
	) => Effect.Effect<RalphRunLoopResult, RalphContractValidationError, never>;
	readonly recordIterationDone: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<RalphDoneResult, RalphContractValidationError, never>;
	readonly handleAgentEnd: (
		cwd: string,
		sessionFile: string | undefined,
		event: AgentEndEvent,
	) => Effect.Effect<RalphAgentEndResult, RalphContractValidationError, never>;
}

export class Ralph extends ServiceMap.Service<Ralph, RalphService>()("Ralph") {}

const stopWithMessage = (message: string): LoopStepResult => ({
	_tag: "stopped",
	message: Option.some(message),
	banner: Option.none(),
});

const blockedWithMessage = (message: string): LoopStepResult => ({
	_tag: "blocked",
	message,
});

const stoppedWithoutMessage: LoopStepResult = {
	_tag: "stopped",
	message: Option.none(),
	banner: Option.none(),
};

const hasCompletionMarker = (event: AgentEndEvent): boolean =>
	extractLastAssistantText(event).includes(COMPLETE_MARKER);

export const RalphLive = (config: RalphLiveConfig) =>
	Layer.effect(
		Ralph,
		Effect.gen(function* () {
			const repo = yield* RalphRepo;
			const loopEngine = yield* LoopEngine;
			const currentLoopRef = yield* Ref.make<Option.Option<string>>(Option.none());
			const waitingAgentEndRef = yield* Ref.make<Option.Option<PendingAgentEndWait>>(
				Option.none(),
			);

			const setCurrentLoop = Effect.fn("Ralph.setCurrentLoop")(
				function* (next: Option.Option<string>) {
					yield* Ref.set(currentLoopRef, next);
				},
			);

			const getCurrentLoop = Ref.get(currentLoopRef);

			const clearCurrentLoop = setCurrentLoop(Option.none());

			const syncCurrentLoopFromSession: RalphService["syncCurrentLoopFromSession"] = Effect.fn(
				"Ralph.syncCurrentLoopFromSession",
			)(function* (cwd, sessionFile) {
				const scoped = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				if (Option.isSome(scoped)) {
					yield* setCurrentLoop(Option.some(scoped.value.name));
				}
			});

			const persistOwnedLoopOnShutdown: RalphService["persistOwnedLoopOnShutdown"] = Effect.fn(
				"Ralph.persistOwnedLoopOnShutdown",
			)(function* (cwd, sessionFile) {
				const scoped = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				if (Option.isSome(scoped)) {
					yield* repo.saveState(cwd, scoped.value);
				}
			});

			const markLoopPaused = Effect.fn("Ralph.markLoopPaused")(
				function* (cwd: string, state: LoopState) {
					if (state.status === "active") {
						yield* repo.saveState(cwd, state);
						yield* mapLoopEngineError(loopEngine.pauseLoop(cwd, state.name));
					} else {
						const pausedState: LoopState = {
							...state,
							status: "paused",
						};
						yield* repo.saveState(cwd, pausedState);
					}
					yield* clearCurrentLoop;
				},
			);

			const markLoopCompleted = Effect.fn("Ralph.markLoopCompleted")(
				function* (cwd: string, state: LoopState) {
					const completedAt = Option.some(yield* nowIso);
					const nextState: LoopState = {
						...state,
						completedAt,
						awaitingFinalize: false,
						advanceRequestedAt: Option.none(),
						activeIterationSessionFile: Option.none(),
					};
					if (nextState.status === "active" || nextState.status === "paused") {
						yield* repo.saveState(cwd, nextState);
						yield* mapLoopEngineError(loopEngine.stopLoop(cwd, nextState.name));
					} else {
						yield* repo.saveState(cwd, {
							...nextState,
							status: "completed",
						});
					}
					yield* clearCurrentLoop;
				},
			);

			const startLoopState: RalphService["startLoopState"] = Effect.fn(
				"Ralph.startLoopState",
			)(function* (cwd, input) {
				const existing = yield* repo.loadState(cwd, input.loopName);
				if (Option.isSome(existing) && existing.value.status === "active") {
					return {
						status: "already_active",
						loopName: input.loopName,
					} satisfies RalphStartLoopStateResult;
				}

				if (Option.isNone(input.controllerSessionFile)) {
					return {
						status: "missing_controller_session",
					} satisfies RalphStartLoopStateResult;
				}

				const createdTask = yield* repo.ensureTaskFile(
					cwd,
					input.taskFile,
					input.defaultTaskTemplate,
				);

				if (Option.isNone(existing)) {
					yield* mapLoopEngineError(
						loopEngine.createLoop(cwd, {
							kind: "ralph",
							taskId: input.loopName,
							title: input.loopName,
							taskContent: input.defaultTaskTemplate,
							maxIterations: input.maxIterations,
							itemsPerIteration: input.itemsPerIteration,
							reflectEvery: input.reflectEvery,
							reflectInstructions: input.reflectInstructions,
							executionProfile: input.executionProfile,
						}),
					);
				} else {
					const preparedState: LoopState = {
						...existing.value,
						taskFile: input.taskFile,
						maxIterations: input.maxIterations,
						itemsPerIteration: input.itemsPerIteration,
						reflectEvery: input.reflectEvery,
						reflectInstructions: input.reflectInstructions,
						executionProfile: input.executionProfile,
						lastReflectionAt: 0,
						activeIterationSessionFile: Option.none(),
						advanceRequestedAt: Option.none(),
						awaitingFinalize: false,
					};
					yield* repo.saveState(cwd, preparedState);
				}

				const controllerSessionFile = Option.getOrUndefined(input.controllerSessionFile);
				if (controllerSessionFile === undefined) {
					return {
						status: "missing_controller_session",
					} satisfies RalphStartLoopStateResult;
				}

				const controller = sessionRefFromFile(controllerSessionFile);
				const startLifecycle = loopEngine.startLoop(cwd, input.loopName, controller).pipe(
					Effect.catch((error) => {
						if (
							error instanceof LoopLifecycleConflictError &&
							error.actual === "paused"
						) {
							return loopEngine.stopLoop(cwd, input.loopName).pipe(
								Effect.flatMap(() =>
									loopEngine.startLoop(cwd, input.loopName, controller),
								),
							);
						}
						return Effect.fail(error);
					}),
				);
				yield* mapLoopEngineError(startLifecycle);
				yield* setCurrentLoop(Option.some(input.loopName));

				const persistedState = yield* repo.loadState(cwd, input.loopName);
				const maxIterations = Option.isSome(persistedState)
					? persistedState.value.maxIterations
					: input.maxIterations;

				return {
					status: "started",
					loopName: input.loopName,
					taskFile: input.taskFile,
					createdTask,
					maxIterations,
				} satisfies RalphStartLoopStateResult;
			});

			const prepareLoopTask: RalphService["prepareLoopTask"] = Effect.fn(
				"Ralph.prepareLoopTask",
			)(function* (cwd, input) {
				const existing = yield* repo.loadState(cwd, input.loopName);
				if (Option.isSome(existing) && existing.value.status === "active") {
					return {
						status: "already_active",
						loopName: input.loopName,
					} satisfies RalphPrepareLoopTaskResult;
				}

				const taskFile = path.join(RALPH_TASKS_DIR, `${input.loopName}.md`);
				yield* repo.writeTaskFile(cwd, taskFile, input.taskContent);
				return {
					status: "prepared",
					taskFile,
				} satisfies RalphPrepareLoopTaskResult;
			});

			const resolveLoopForUi: RalphService["resolveLoopForUi"] = Effect.fn(
				"Ralph.resolveLoopForUi",
			)(function* (cwd, sessionFile) {
				const currentLoop = yield* getCurrentLoop;
				const fromCurrent = Option.isSome(currentLoop)
					? yield* repo.loadState(cwd, currentLoop.value)
					: Option.none<LoopState>();

				if (Option.isSome(fromCurrent)) {
					yield* setCurrentLoop(Option.some(fromCurrent.value.name));
					return fromCurrent;
				}

				const fromSession = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				if (Option.isSome(fromSession)) {
					yield* setCurrentLoop(Option.some(fromSession.value.name));
				}
				return fromSession;
			});

			const pauseCurrentLoop: RalphService["pauseCurrentLoop"] = Effect.fn(
				"Ralph.pauseCurrentLoop",
			)(function* (cwd) {
				const currentLoop = yield* getCurrentLoop;
				if (Option.isSome(currentLoop)) {
					const stateOption = yield* repo.loadState(cwd, currentLoop.value);
					if (Option.isNone(stateOption)) {
						return {
							status: "missing_current_loop_state",
						} satisfies RalphPauseCurrentLoopResult;
					}
					if (stateOption.value.status === "active") {
						yield* mapLoopEngineError(
							loopEngine.pauseLoop(cwd, stateOption.value.name),
						);
						yield* clearCurrentLoop;
						return {
							status: "paused",
							loopName: stateOption.value.name,
							iteration: stateOption.value.iteration,
						} satisfies RalphPauseCurrentLoopResult;
					}
					if (stateOption.value.status === "paused") {
						return {
							status: "paused",
							loopName: stateOption.value.name,
							iteration: stateOption.value.iteration,
						} satisfies RalphPauseCurrentLoopResult;
					}
				}

				const active = (yield* repo.listLoops(cwd)).find((loop) => loop.status === "active");
				if (active === undefined) {
					return {
						status: "no_active_loop",
					} satisfies RalphPauseCurrentLoopResult;
				}

				yield* mapLoopEngineError(loopEngine.pauseLoop(cwd, active.name));
				yield* clearCurrentLoop;
				return {
					status: "paused",
					loopName: active.name,
					iteration: active.iteration,
				} satisfies RalphPauseCurrentLoopResult;
			});

			const stopActiveLoop: RalphService["stopActiveLoop"] = Effect.fn(
				"Ralph.stopActiveLoop",
			)(function* (cwd) {
				const currentLoop = yield* getCurrentLoop;
				const maybeCurrentState = Option.isSome(currentLoop)
					? yield* repo.loadState(cwd, currentLoop.value)
					: Option.none<LoopState>();
				const fallbackActive = (yield* repo.listLoops(cwd)).find((loop) => loop.status === "active");
				const resolvedState = Option.isSome(maybeCurrentState)
					? maybeCurrentState
					: fallbackActive === undefined
						? Option.none<LoopState>()
						: Option.some(fallbackActive);

				if (Option.isNone(resolvedState)) {
					return {
						status: "no_active_loop",
					} satisfies RalphStopLoopResult;
				}

				const state = resolvedState.value;
				if (state.status !== "active") {
					return {
						status: "not_active",
						loopName: state.name,
					} satisfies RalphStopLoopResult;
				}

				yield* mapLoopEngineError(loopEngine.stopLoop(cwd, state.name));
				yield* clearCurrentLoop;
				return {
					status: "stopped",
					loopName: state.name,
					iteration: state.iteration,
				} satisfies RalphStopLoopResult;
			});

			const resumeLoopState: RalphService["resumeLoopState"] = Effect.fn(
				"Ralph.resumeLoopState",
			)(function* (cwd, loopName) {
				const stateOption = yield* repo.loadState(cwd, loopName);
				if (Option.isNone(stateOption)) {
					return {
						status: "not_found",
					} satisfies RalphResumeLoopStateResult;
				}

				const state = stateOption.value;
				if (state.status === "completed") {
					return {
						status: "completed",
					} satisfies RalphResumeLoopStateResult;
				}
				const controllerSessionFile = Option.getOrUndefined(state.controllerSessionFile);
				if (controllerSessionFile === undefined) {
					return yield* Effect.fail(
						toContractError(
							"ralph.controller_session",
							`Loop "${loopName}" has no controller session file`,
						),
					);
				}

				const currentLoop = yield* getCurrentLoop;
				if (Option.isSome(currentLoop) && currentLoop.value !== loopName) {
					const currentState = yield* repo.loadState(cwd, currentLoop.value);
					if (Option.isSome(currentState) && currentState.value.status === "active") {
						yield* mapLoopEngineError(
							loopEngine.pauseLoop(cwd, currentState.value.name),
						);
					}
				}

				if (state.status === "paused") {
					yield* mapLoopEngineError(
						loopEngine.resumeLoop(cwd, loopName, sessionRefFromFile(controllerSessionFile)),
					);
				}
				yield* setCurrentLoop(Option.some(loopName));

				return {
					status: "resumed",
					loopName,
				} satisfies RalphResumeLoopStateResult;
			});

			const cancelLoop: RalphService["cancelLoop"] = Effect.fn("Ralph.cancelLoop")(
				function* (cwd, loopName) {
					const state = yield* repo.loadState(cwd, loopName);
					if (Option.isNone(state)) {
						return {
							status: "not_found",
						} satisfies RalphCancelLoopResult;
					}
					if (state.value.status === "active") {
						yield* mapLoopEngineError(loopEngine.pauseLoop(cwd, loopName));
					}

					const currentLoop = yield* getCurrentLoop;
					if (Option.isSome(currentLoop) && currentLoop.value === loopName) {
						yield* clearCurrentLoop;
					}

					yield* mapLoopEngineError(loopEngine.cancelLoop(cwd, loopName));
					return {
						status: "cancelled",
					} satisfies RalphCancelLoopResult;
				},
			);

			const archiveLoopByName: RalphService["archiveLoopByName"] = Effect.fn(
				"Ralph.archiveLoopByName",
			)(function* (cwd, loopName) {
				const stateOption = yield* repo.loadState(cwd, loopName);
				if (Option.isNone(stateOption)) {
					return {
						status: "not_found",
					} satisfies RalphArchiveLoopByNameResult;
				}

				const state = stateOption.value;
				if (state.status === "active") {
					return {
						status: "active_loop",
					} satisfies RalphArchiveLoopByNameResult;
				}

				const currentLoop = yield* getCurrentLoop;
				if (Option.isSome(currentLoop) && currentLoop.value === loopName) {
					yield* clearCurrentLoop;
				}

				yield* mapLoopEngineError(loopEngine.archiveLoop(cwd, state.name));
				return {
					status: "archived",
				} satisfies RalphArchiveLoopByNameResult;
			});

			const cleanCompletedLoops: RalphService["cleanCompletedLoops"] = Effect.fn(
				"Ralph.cleanCompletedLoops",
			)(function* (cwd, all) {
				const cleaned = yield* mapLoopEngineError(loopEngine.cleanLoops(cwd, all));
				const currentLoop = yield* getCurrentLoop;
				if (
					Option.isSome(currentLoop) &&
					cleaned.cleanedTaskIds.includes(currentLoop.value)
				) {
					yield* clearCurrentLoop;
				}

				return {
					cleanedLoops: [...cleaned.cleanedTaskIds],
				} satisfies RalphCleanCompletedLoopsResult;
			});

			const nukeLoops: RalphService["nukeLoops"] = Effect.fn("Ralph.nukeLoops")(
				function* (cwd) {
					const exists = yield* repo.existsRalphDirectory(cwd);
					if (!exists) {
						return {
							removed: false,
						} satisfies RalphNukeLoopsResult;
					}

					yield* clearCurrentLoop;
					yield* repo.removeRalphDirectory(cwd);
					return {
						removed: true,
					} satisfies RalphNukeLoopsResult;
				},
			);

			const pauseLoop = (
				cwd: string,
				state: LoopState,
				message: string,
				kind: "blocked" | "stopped",
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					yield* markLoopPaused(cwd, state);
					return kind === "blocked" ? blockedWithMessage(message) : stopWithMessage(message);
				});

			const completeLoop = (
				cwd: string,
				state: LoopState,
				banner: string,
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					yield* markLoopCompleted(cwd, state);
					return {
						_tag: "stopped",
						message: Option.none(),
						banner: Option.some(banner),
					} satisfies LoopStepResult;
				});

			const finalizePendingIteration = (
				boundary: RalphCommandBoundary,
				loopName: string,
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					const stateOption = yield* repo.loadState(boundary.cwd, loopName);
					if (Option.isNone(stateOption) || stateOption.value.status !== "active") {
						return stoppedWithoutMessage;
					}

					const state = stateOption.value;
					if (!state.awaitingFinalize) {
						return continueLoop;
					}

					if (yield* config.hasActiveSubagents()) {
						state.activeIterationSessionFile = Option.none();
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Ralph paused: subagents are still active. Complete or close them, then run /ralph resume to continue.",
							"blocked",
						);
					}

					state.awaitingFinalize = false;
					state.advanceRequestedAt = Option.none();
					state.activeIterationSessionFile = Option.none();
					yield* repo.saveState(boundary.cwd, state);
					return continueLoop;
				});

			const waitForAgentEnd = Effect.fn("Ralph.waitForAgentEnd")(function* (iterationSessionFile: string) {
				const deferred = yield* Deferred.make<AgentEndEvent>();
				yield* Ref.set(
					waitingAgentEndRef,
					Option.some({
						deferred,
						iterationSessionFile,
					}),
				);
				const awaitEvent = Deferred.await(deferred).pipe(
					Effect.ensuring(
						Ref.update(waitingAgentEndRef, (current) =>
							Option.isSome(current) && current.value.deferred === deferred
								? Option.none()
								: current,
						),
					),
				);
				return { awaitEvent } as const;
			});

			const runSingleIteration = (
				boundary: RalphCommandBoundary,
				loopName: string,
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					const stateOption = yield* repo.loadState(boundary.cwd, loopName);
					if (Option.isNone(stateOption) || stateOption.value.status !== "active") {
						return stoppedWithoutMessage;
					}

					const state = stateOption.value;
					if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
						return yield* completeLoop(
							boundary.cwd,
							state,
							`───────────────────────────────────────────────────────────────────────\n⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached\n───────────────────────────────────────────────────────────────────────`,
						);
					}

					const controllerSession = Option.getOrUndefined(state.controllerSessionFile);
					if (controllerSession === undefined) {
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Ralph loop has no controller session file. Loop paused.",
							"stopped",
						);
					}

					if (boundary.getSessionFile() !== controllerSession) {
						const switched = yield* boundary.switchSession(controllerSession);
						if (switched.cancelled) {
							return yield* pauseLoop(
								boundary.cwd,
								state,
								"Could not switch to Ralph controller session.",
								"stopped",
							);
						}
					}

					if (yield* config.hasActiveSubagents()) {
						state.awaitingFinalize = true;
						state.activeIterationSessionFile = Option.none();
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Ralph paused: subagents became active. Complete or close them, then run /ralph resume to continue.",
							"blocked",
						);
					}

					const child = yield* boundary.newSession({ parentSession: controllerSession });
					if (child.cancelled) {
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Creating Ralph iteration session was cancelled.",
							"stopped",
						);
					}

					const afterSessionOption = yield* repo.loadState(boundary.cwd, loopName);
					if (Option.isNone(afterSessionOption) || afterSessionOption.value.status !== "active") {
						return stoppedWithoutMessage;
					}

					const afterSession = afterSessionOption.value;
					afterSession.iteration += 1;
					const iterationSessionFile = boundary.getSessionFile();
					if (iterationSessionFile === undefined) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							"Ralph iteration session has no session file. Loop paused.",
							"stopped",
						);
					}
					afterSession.activeIterationSessionFile = Option.none();
					afterSession.awaitingFinalize = false;
					afterSession.advanceRequestedAt = Option.none();
					const executionProfileApplied = yield* boundary.applyExecutionProfile(afterSession.executionProfile);
					if (!executionProfileApplied.applied) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							`Could not apply Ralph execution profile: ${executionProfileApplied.reason ?? "unknown error"}`,
							"stopped",
						);
					}
					yield* repo.saveState(boundary.cwd, afterSession);
					yield* mapLoopEngineError(
						loopEngine.attachChildSession(
							boundary.cwd,
							loopName,
							sessionRefFromFile(iterationSessionFile),
						),
					);
					yield* setCurrentLoop(Option.some(loopName));

					const taskContent = yield* repo.readTaskFile(boundary.cwd, afterSession.taskFile);
					if (Option.isNone(taskContent)) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							`Could not read Ralph task file: ${afterSession.taskFile}`,
							"stopped",
						);
					}

					const needsReflection =
						afterSession.reflectEvery > 0 &&
						afterSession.iteration > 1 &&
						(afterSession.iteration - 1) % afterSession.reflectEvery === 0;

					const { awaitEvent } = yield* waitForAgentEnd(iterationSessionFile);
					yield* boundary.sendFollowUp(buildPrompt(afterSession, taskContent.value, needsReflection));
					const event = yield* awaitEvent;

					const afterTurnOption = yield* repo.loadState(boundary.cwd, loopName);
					if (Option.isNone(afterTurnOption) || afterTurnOption.value.status !== "active") {
						return stoppedWithoutMessage;
					}

					const afterTurn = afterTurnOption.value;
					if (hasCompletionMarker(event)) {
						return yield* completeLoop(
							boundary.cwd,
							afterTurn,
							`───────────────────────────────────────────────────────────────────────\n✅ RALPH LOOP COMPLETE: ${afterTurn.name} | ${afterTurn.iteration} iterations\n───────────────────────────────────────────────────────────────────────`,
						);
					}

					if (!afterTurn.awaitingFinalize) {
						return yield* pauseLoop(
							boundary.cwd,
							afterTurn,
							`Iteration ${afterTurn.iteration} ended without ralph_done. Ralph paused. Use /ralph resume ${loopName} to continue.`,
							"stopped",
						);
					}

					return continueLoop;
				});

			const runLoop: RalphService["runLoop"] = Effect.fn("Ralph.runLoop")(
				function* (boundary, loopName) {
					while (true) {
						const stateOption = yield* repo.loadState(boundary.cwd, loopName);
						if (Option.isNone(stateOption) || stateOption.value.status !== "active") {
							return {
								status: "stopped",
								message: Option.none(),
								banner: Option.none(),
							} satisfies RalphRunLoopResult;
						}

						yield* setCurrentLoop(Option.some(loopName));

						const finalize = yield* finalizePendingIteration(boundary, loopName);
						if (finalize._tag === "blocked") {
							return {
								status: "blocked",
								message: Option.some(finalize.message),
								banner: Option.none(),
							} satisfies RalphRunLoopResult;
						}
						if (finalize._tag === "stopped") {
							return {
								status: "stopped",
								message: finalize.message,
								banner: finalize.banner,
							} satisfies RalphRunLoopResult;
						}

						const iteration = yield* runSingleIteration(boundary, loopName);
						if (iteration._tag === "continue") {
							continue;
						}
						if (iteration._tag === "blocked") {
							return {
								status: "blocked",
								message: Option.some(iteration.message),
								banner: Option.none(),
							} satisfies RalphRunLoopResult;
						}
						return {
							status: "stopped",
							message: iteration.message,
							banner: iteration.banner,
						} satisfies RalphRunLoopResult;
					}
				},
			);

			const recordIterationDone: RalphService["recordIterationDone"] = Effect.fn(
				"Ralph.recordIterationDone",
			)(function* (cwd, sessionFile) {
				const stateOption = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				if (Option.isNone(stateOption)) {
					return { text: "No active Ralph loop." } satisfies RalphDoneResult;
				}

				const state = stateOption.value;
				if (state.status !== "active") {
					return { text: "Ralph loop is not active." } satisfies RalphDoneResult;
				}
				if (!optionContains(state.activeIterationSessionFile, sessionFile)) {
					return { text: "No active Ralph loop." } satisfies RalphDoneResult;
				}
				const timestamp = yield* nowIso;
				if (yield* config.hasActiveSubagents()) {
					state.awaitingFinalize = true;
					state.advanceRequestedAt = Option.some(timestamp);
					state.activeIterationSessionFile = Option.none();
					yield* markLoopPaused(cwd, state);
					return {
						text: "Ralph iteration recorded. Subagents are still active, so advancement is blocked until they finish. Run /ralph resume when they are done.",
					} satisfies RalphDoneResult;
				}

				state.advanceRequestedAt = Option.some(timestamp);
				state.awaitingFinalize = true;
				yield* repo.saveState(cwd, state);
				yield* setCurrentLoop(Option.some(state.name));
				return {
					text: `Iteration ${state.iteration} complete. Finalize recorded.`,
				} satisfies RalphDoneResult;
			});

			const handleAgentEnd: RalphService["handleAgentEnd"] = Effect.fn(
				"Ralph.handleAgentEnd",
			)(function* (cwd, sessionFile, event) {
				const stateOption = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				const ownedActiveState =
					Option.isSome(stateOption) &&
					stateOption.value.status === "active" &&
					optionContains(stateOption.value.activeIterationSessionFile, sessionFile)
						? Option.some(stateOption.value)
						: Option.none<LoopState>();

				const pending = yield* Ref.get(waitingAgentEndRef);
				if (
					Option.isSome(pending) &&
					pending.value.iterationSessionFile === sessionFile
				) {
					yield* Ref.set(waitingAgentEndRef, Option.none());
					yield* Deferred.succeed(pending.value.deferred, event);
					return {
						consumedByWaitingLoop: true,
						banner: Option.none(),
					} satisfies RalphAgentEndResult;
				}

				if (Option.isNone(ownedActiveState)) {
					return {
						consumedByWaitingLoop: false,
						banner: Option.none(),
					} satisfies RalphAgentEndResult;
				}

				const state = ownedActiveState.value;

				if (!hasCompletionMarker(event)) {
					return {
						consumedByWaitingLoop: false,
						banner: Option.none(),
					} satisfies RalphAgentEndResult;
				}

				state.awaitingFinalize = false;
				state.advanceRequestedAt = Option.none();
				state.activeIterationSessionFile = Option.none();
				yield* markLoopCompleted(cwd, state);

				return {
					consumedByWaitingLoop: false,
					banner: Option.some(
						`───────────────────────────────────────────────────────────────────────\n✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations\n───────────────────────────────────────────────────────────────────────`,
					),
				} satisfies RalphAgentEndResult;
			});

			return Ralph.of({
				startLoopState,
				prepareLoopTask,
				listLoops: repo.listLoops,
				findLoopBySessionFile: repo.findLoopBySessionFile,
				resolveLoopForUi,
				pauseCurrentLoop,
				stopActiveLoop,
				resumeLoopState,
				cancelLoop,
				archiveLoopByName,
				cleanCompletedLoops,
				nukeLoops,
				existsRalphDirectory: repo.existsRalphDirectory,
				syncCurrentLoopFromSession,
				persistOwnedLoopOnShutdown,
				runLoop,
				recordIterationDone,
				handleAgentEnd,
			});
		}),
	);
