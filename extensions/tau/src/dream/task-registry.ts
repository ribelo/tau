import { Clock, Effect, Fiber, Layer, Option, Ref, ServiceMap, Stream, SubscriptionRef } from "effect";
import { nanoid } from "nanoid";

import type { MemoryFileError, MemoryMutationError } from "../memory/errors.js";
import type {
	DreamProgressEvent,
	DreamRunRequest,
	DreamRunResult,
	DreamTaskHandle,
	DreamTaskId,
	DreamTaskState,
} from "./domain.js";
import type { DreamConfigError, DreamGateError, DreamLockError, DreamSubagentError } from "./errors.js";

export type DreamRunError =
	| DreamConfigError
	| DreamGateError
	| DreamLockError
	| DreamSubagentError
	| MemoryMutationError
	| MemoryFileError;

export interface DreamTaskRegistryApi {
	readonly create: (request: DreamRunRequest) => Effect.Effect<DreamTaskHandle>;
	readonly attach: (
		taskId: DreamTaskId,
		fiber: Fiber.Fiber<DreamRunResult, DreamRunError>,
	) => Effect.Effect<void>;
	readonly report: (taskId: DreamTaskId, event: DreamProgressEvent) => Effect.Effect<void>;
	readonly complete: (taskId: DreamTaskId, result: DreamRunResult) => Effect.Effect<void>;
	readonly fail: (taskId: DreamTaskId, cause: DreamRunError) => Effect.Effect<void>;
	readonly cancel: (taskId: DreamTaskId) => Effect.Effect<void>;
	readonly get: (taskId: DreamTaskId) => Effect.Effect<DreamTaskState>;
	readonly watch: (taskId: DreamTaskId) => Stream.Stream<DreamTaskState>;
}

export class DreamTaskRegistry extends ServiceMap.Service<DreamTaskRegistry, DreamTaskRegistryApi>()(
	"DreamTaskRegistry",
) {}

type DreamTaskFiber = Fiber.Fiber<DreamRunResult, DreamRunError>;

interface DreamTaskRecord {
	readonly state: DreamTaskState;
	readonly fiber: Option.Option<DreamTaskFiber>;
	readonly updates: SubscriptionRef.SubscriptionRef<DreamTaskState>;
}

const taskNotFound = (taskId: DreamTaskId): Error =>
	new Error(`Dream task not found: ${taskId}`);

const isTerminal = (state: DreamTaskState): boolean => state.status !== "running";

const applyProgressEvent = (
	state: DreamTaskState,
	event: DreamProgressEvent,
): DreamTaskState => {
	switch (event._tag) {
		case "PhaseChanged":
			return event.message === undefined
				? { ...state, phase: event.phase }
				: { ...state, phase: event.phase, latestMessage: event.message };
		case "SessionsDiscovered":
			return { ...state, sessionsDiscovered: event.total };
		case "SessionsReviewed":
			return {
				...state,
				sessionsReviewed: event.reviewed,
				sessionsDiscovered: Math.max(state.sessionsDiscovered, event.total),
			};
		case "OperationsPlanned":
			return { ...state, operationsPlanned: event.total };
		case "OperationApplied":
			return {
				...state,
				operationsApplied: event.applied,
				operationsPlanned: Math.max(state.operationsPlanned, event.total),
				latestMessage: event.summary,
			};
		case "Note":
			return { ...state, latestMessage: event.text };
	}
};

export const DreamTaskRegistryLive = Layer.effect(
	DreamTaskRegistry,
	Effect.gen(function* () {
		const tasksRef = yield* Ref.make(new Map<DreamTaskId, DreamTaskRecord>());

		const getRecord = Effect.fn("DreamTaskRegistry.getRecord")(
			function* (taskId: DreamTaskId) {
				const tasks = yield* Ref.get(tasksRef);
				const record = tasks.get(taskId);
				if (record === undefined) {
					return yield* Effect.die(taskNotFound(taskId));
				}
				return record;
			},
		);

		const setRecord = Effect.fn("DreamTaskRegistry.setRecord")(
			function* (taskId: DreamTaskId, record: DreamTaskRecord) {
				yield* Ref.update(tasksRef, (tasks) => {
					const next = new Map(tasks);
					next.set(taskId, record);
					return next;
				});
			},
		);

		const create: DreamTaskRegistryApi["create"] = Effect.fn("DreamTaskRegistry.create")(
			function* (request) {
				const startedAt = yield* Clock.currentTimeMillis;
				const taskId: DreamTaskId = nanoid();
				const state: DreamTaskState = {
					id: taskId,
					type: "dream",
					mode: request.mode,
					status: "running",
					phase: "queued",
					startedAt,
					sessionsDiscovered: 0,
					sessionsReviewed: 0,
					operationsPlanned: 0,
					operationsApplied: 0,
					cancellable: true,
				};

				const updates = yield* SubscriptionRef.make(state);
				const record: DreamTaskRecord = {
					state,
					fiber: Option.none(),
					updates,
				};

				yield* Ref.update(tasksRef, (tasks) => {
					const next = new Map(tasks);
					next.set(taskId, record);
					return next;
				});

				return { taskId } satisfies DreamTaskHandle;
			},
		);

		const attach: DreamTaskRegistryApi["attach"] = Effect.fn("DreamTaskRegistry.attach")(
			function* (taskId, fiber) {
				const record = yield* getRecord(taskId);
				yield* setRecord(taskId, {
					...record,
					fiber: Option.some(fiber),
				});
			},
		);

		const report: DreamTaskRegistryApi["report"] = Effect.fn("DreamTaskRegistry.report")(
			function* (taskId, event) {
				const record = yield* getRecord(taskId);
				if (isTerminal(record.state)) {
					return;
				}

				const nextState = applyProgressEvent(record.state, event);
				yield* setRecord(taskId, {
					...record,
					state: nextState,
				});
				yield* SubscriptionRef.set(record.updates, nextState);
			},
		);

		const complete: DreamTaskRegistryApi["complete"] = Effect.fn("DreamTaskRegistry.complete")(
			function* (taskId, result) {
				const record = yield* getRecord(taskId);
				if (isTerminal(record.state)) {
					return;
				}

				const nextState: DreamTaskState = {
					...record.state,
					status: "completed",
					phase: "done",
					finishedAt: result.finishedAt,
					sessionsDiscovered: Math.max(
						record.state.sessionsDiscovered,
						result.reviewedSessions.length,
					),
					sessionsReviewed: result.reviewedSessions.length,
					operationsPlanned: result.plan.operations.length,
					operationsApplied: result.applied.length,
					latestMessage: result.plan.summary,
					cancellable: false,
				};

				yield* setRecord(taskId, {
					...record,
					state: nextState,
					fiber: Option.none(),
				});
				yield* SubscriptionRef.set(record.updates, nextState);
			},
		);

		const fail: DreamTaskRegistryApi["fail"] = Effect.fn("DreamTaskRegistry.fail")(
			function* (taskId, cause) {
				const finishedAt = yield* Clock.currentTimeMillis;
				const record = yield* getRecord(taskId);
				if (isTerminal(record.state)) {
					return;
				}

				const nextState: DreamTaskState = {
					...record.state,
					status: "failed",
					finishedAt,
					latestMessage: cause._tag,
					cancellable: false,
				};

				yield* setRecord(taskId, {
					...record,
					state: nextState,
					fiber: Option.none(),
				});
				yield* SubscriptionRef.set(record.updates, nextState);
			},
		);

		const cancel: DreamTaskRegistryApi["cancel"] = Effect.fn("DreamTaskRegistry.cancel")(
			function* (taskId) {
				const finishedAt = yield* Clock.currentTimeMillis;
				const record = yield* getRecord(taskId);
				if (isTerminal(record.state)) {
					return;
				}

				const nextState: DreamTaskState = {
					...record.state,
					status: "cancelled",
					finishedAt,
					cancellable: false,
				};

				yield* setRecord(taskId, {
					...record,
					state: nextState,
					fiber: Option.none(),
				});
				yield* SubscriptionRef.set(record.updates, nextState);

				if (Option.isSome(record.fiber)) {
					yield* Fiber.interrupt(record.fiber.value);
				}
			},
		);

		const get: DreamTaskRegistryApi["get"] = Effect.fn("DreamTaskRegistry.get")(
			function* (taskId) {
				const record = yield* getRecord(taskId);
				return record.state;
			},
		);

		const watch: DreamTaskRegistryApi["watch"] = (taskId) =>
			Stream.unwrap(getRecord(taskId).pipe(Effect.map((record) => SubscriptionRef.changes(record.updates))));

		return DreamTaskRegistry.of({
			create,
			attach,
			report,
			complete,
			fail,
			cancel,
			get,
			watch,
		});
	}),
);
