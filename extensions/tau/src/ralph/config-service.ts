import { Effect, Option, Schema } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import { RalphContractValidationError } from "../ralph/errors.js";
import type { LoopState } from "./schema.js";
import type { RalphRepoService } from "./repo.js";
import type { RalphCapabilityContract } from "./contract.js";

// ─── Error types ────────────────────────────────────────────────────────────

export class RalphConfigError {
	readonly entity: string;
	readonly reason: string;
	constructor(props: { readonly reason: string; readonly entity?: string }) {
		this.entity = props.entity ?? "ralph.config";
		this.reason = props.reason;
	}
}

export class RalphConfigUnsafeEditError extends RalphConfigError {
	readonly _tag = "RalphConfigUnsafeEditError";
	constructor(reason: string) {
		super({ entity: "ralph.config.unsafe_edit", reason });
	}
}

export class RalphConfigLoopNotFoundError extends RalphConfigError {
	readonly _tag = "RalphConfigLoopNotFoundError";
	constructor(loopName: string) {
		super({ entity: "ralph.config.not_found", reason: `Loop "${loopName}" not found` });
	}
}

export class RalphConfigInvalidFieldError extends RalphConfigError {
	readonly _tag = "RalphConfigInvalidFieldError";
	constructor(field: string, reason: string) {
		super({ entity: `ralph.config.field.${field}`, reason });
	}
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type RalphConfigMutation =
	| { readonly kind: "maxIterations"; readonly value: number }
	| { readonly kind: "itemsPerIteration"; readonly value: number }
	| { readonly kind: "reflectEvery"; readonly value: number }
	| { readonly kind: "reflectInstructions"; readonly value: string }
	| { readonly kind: "capabilityContractTools"; readonly activeNames: ReadonlyArray<string> }
	| { readonly kind: "capabilityContractAgents"; readonly enabledNames: ReadonlyArray<string> }
	| { readonly kind: "executionProfile"; readonly profile: ExecutionProfile }
	| { readonly kind: "sandboxProfile"; readonly profile: ResolvedSandboxConfig };

export type RalphConfigResult =
	| { readonly status: "updated"; readonly loopName: string }
	| { readonly status: "no_change"; readonly loopName: string }
	| { readonly status: "refused"; readonly loopName: string; readonly reason: string };

// ─── Pure helpers ───────────────────────────────────────────────────────────

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

function isActiveChildPresent(state: LoopState): boolean {
	return state.activeIterationSessionFile !== undefined;
}

function isActiveLoop(state: LoopState): boolean {
	return state.status === "active";
}

function validateMutationSafety(
	state: LoopState,
	mutation: RalphConfigMutation,
): void | RalphConfigUnsafeEditError {
	// Scalar mutations are always safe even when active
	if (
		mutation.kind === "maxIterations" ||
		mutation.kind === "itemsPerIteration" ||
		mutation.kind === "reflectEvery" ||
		mutation.kind === "reflectInstructions"
	) {
		return undefined;
	}

	// Contract/execution/sandbox mutations are unsafe when a child is actively running
	if (isActiveLoop(state) && isActiveChildPresent(state)) {
		return new RalphConfigUnsafeEditError(
			`Loop "${state.name}" has an active child session. ` +
				`Finish the current iteration or pause the loop before changing ${mutation.kind}.`,
		);
	}

	return undefined;
}

function applyMutation(state: LoopState, mutation: RalphConfigMutation): LoopState {
	switch (mutation.kind) {
		case "maxIterations": {
			return { ...state, maxIterations: mutation.value };
		}
		case "itemsPerIteration": {
			return { ...state, itemsPerIteration: mutation.value };
		}
		case "reflectEvery": {
			return { ...state, reflectEvery: mutation.value };
		}
		case "reflectInstructions": {
			return { ...state, reflectInstructions: mutation.value };
		}
		case "capabilityContractTools": {
			return {
				...state,
				capabilityContract: {
					...state.capabilityContract,
					tools: {
						...state.capabilityContract.tools,
						activeNames: [...mutation.activeNames],
					},
				},
			};
		}
		case "capabilityContractAgents": {
			return {
				...state,
				capabilityContract: {
					...state.capabilityContract,
					agents: {
						...state.capabilityContract.agents,
						enabledNames: [...mutation.enabledNames],
					},
				},
			};
		}
		case "executionProfile": {
			return { ...state, executionProfile: mutation.profile };
		}
		case "sandboxProfile": {
			return { ...state, sandboxProfile: Option.some(mutation.profile) };
		}
	}
}

function statesEqual(a: LoopState, b: LoopState): boolean {
	// Fast structural comparison for key fields; full deep equality not needed
	if (
		a.maxIterations !== b.maxIterations ||
		a.itemsPerIteration !== b.itemsPerIteration ||
		a.reflectEvery !== b.reflectEvery ||
		a.reflectInstructions !== b.reflectInstructions ||
		a.executionProfile !== b.executionProfile ||
		a.sandboxProfile !== b.sandboxProfile ||
		a.capabilityContract !== b.capabilityContract
	) {
		return false;
	}
	return true;
}

// ─── Validation helpers ─────────────────────────────────────────────────────

function validateNonNegativeInteger(
	field: string,
	value: number,
): void | RalphConfigInvalidFieldError {
	const decoded = Schema.decodeUnknownOption(NonNegativeIntSchema)(value);
	if (Option.isNone(decoded)) {
		return new RalphConfigInvalidFieldError(field, `expected non-negative integer, got ${value}`);
	}
	return undefined;
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface RalphLoopConfigService {
	/**
	 * Load a Ralph loop state by name for configuration.
	 */
	readonly loadLoop: (
		cwd: string,
		loopName: string,
	) => Promise<LoopState>;

	/**
	 * Apply a single mutation with load-validate-write discipline.
	 */
	readonly mutate: (
		cwd: string,
		loopName: string,
		mutation: RalphConfigMutation,
	) => Promise<RalphConfigResult>;

	/**
	 * Apply multiple mutations atomically (same load-validate-write cycle).
	 */
	readonly mutateMany: (
		cwd: string,
		loopName: string,
		mutations: ReadonlyArray<RalphConfigMutation>,
	) => Promise<RalphConfigResult>;

	/**
	 * Recapture execution profile from current session and store it in loop state.
	 */
	readonly recaptureExecutionProfile: (
		cwd: string,
		loopName: string,
		profile: ExecutionProfile,
	) => Promise<RalphConfigResult>;

	/**
	 * Recapture sandbox profile from current session and store it in loop state.
	 */
	readonly recaptureSandboxProfile: (
		cwd: string,
		loopName: string,
		profile: ResolvedSandboxConfig,
	) => Promise<RalphConfigResult>;
}

export function makeRalphLoopConfigService(
	repo: RalphRepoService,
): RalphLoopConfigService {
	const loadLoop = async (cwd: string, loopName: string): Promise<LoopState> => {
		const stateOption = await repo.loadState(cwd, loopName).pipe(
			Effect.mapError(
				(error) =>
					new RalphConfigError({
						entity: "ralph.config.load",
						reason: String(error),
					}),
			),
			Effect.runPromise,
		);
		if (Option.isNone(stateOption)) {
			throw new RalphConfigLoopNotFoundError(loopName);
		}
		return stateOption.value;
	};

	const writeIfChanged = async (
		cwd: string,
		original: LoopState,
		mutated: LoopState,
		loopName: string,
	): Promise<RalphConfigResult> => {
		if (statesEqual(original, mutated)) {
			return { status: "no_change", loopName };
		}
		await repo.saveState(cwd, mutated).pipe(
			Effect.mapError(
				(error) =>
					new RalphConfigError({
						entity: "ralph.config.save",
						reason: String(error),
					}),
			),
			Effect.runPromise,
		);
		return { status: "updated", loopName };
	};

	const mutate = async (
		cwd: string,
		loopName: string,
		mutation: RalphConfigMutation,
	): Promise<RalphConfigResult> => mutateMany(cwd, loopName, [mutation]);

	const mutateMany = async (
		cwd: string,
		loopName: string,
		mutations: ReadonlyArray<RalphConfigMutation>,
	): Promise<RalphConfigResult> => {
		const original = await loadLoop(cwd, loopName);

		// Validate all mutations before applying any
		for (const mutation of mutations) {
			if (
				mutation.kind === "maxIterations" ||
				mutation.kind === "itemsPerIteration" ||
				mutation.kind === "reflectEvery"
			) {
				const validation = validateNonNegativeInteger(mutation.kind, mutation.value);
				if (validation !== undefined) {
					throw validation;
				}
			}

			const safety = validateMutationSafety(original, mutation);
			if (safety !== undefined) {
				return { status: "refused", loopName, reason: safety.reason };
			}
		}

		let mutated = original;
		for (const mutation of mutations) {
			mutated = applyMutation(mutated, mutation);
		}

		return writeIfChanged(cwd, original, mutated, loopName);
	};

	const recaptureExecutionProfile = async (
		cwd: string,
		loopName: string,
		profile: ExecutionProfile,
	): Promise<RalphConfigResult> => mutate(cwd, loopName, { kind: "executionProfile", profile });

	const recaptureSandboxProfile = async (
		cwd: string,
		loopName: string,
		profile: ResolvedSandboxConfig,
	): Promise<RalphConfigResult> => mutate(cwd, loopName, { kind: "sandboxProfile", profile });

	return {
		loadLoop,
		mutate,
		mutateMany,
		recaptureExecutionProfile,
		recaptureSandboxProfile,
	};
}
