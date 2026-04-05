import { Effect, Schema } from "effect";

import { RalphContractValidationError } from "./errors.js";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalStringSchema = Schema.OptionFromNullOr(Schema.String);

export function sanitizeLoopName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_");
}

function toContractValidationError(entity: string, error: unknown): RalphContractValidationError {
	return new RalphContractValidationError({
		reason: String(error),
		entity,
	});
}

export const LoopStatusSchema = Schema.Literals(["active", "paused", "completed"]);
export type LoopStatus = Schema.Schema.Type<typeof LoopStatusSchema>;

export const LoopNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(120)).check(
	Schema.makeFilter(
		(value) =>
			value === sanitizeLoopName(value) || "expected a sanitized ralph loop name",
	),
);
export type LoopName = Schema.Schema.Type<typeof LoopNameSchema>;

export const LoopStateSchema = Schema.Struct({
	name: LoopNameSchema,
	taskFile: Schema.NonEmptyString,
	iteration: Schema.mutableKey(NonNegativeIntSchema),
	maxIterations: NonNegativeIntSchema,
	itemsPerIteration: NonNegativeIntSchema,
	reflectEvery: NonNegativeIntSchema,
	reflectInstructions: Schema.String,
	status: Schema.mutableKey(LoopStatusSchema),
	startedAt: Schema.String,
	completedAt: Schema.mutableKey(OptionalStringSchema),
	lastReflectionAt: Schema.mutableKey(NonNegativeIntSchema),
	controllerSessionFile: Schema.mutableKey(OptionalStringSchema),
	activeIterationSessionFile: Schema.mutableKey(OptionalStringSchema),
	advanceRequestedAt: Schema.mutableKey(OptionalStringSchema),
	awaitingFinalize: Schema.mutableKey(Schema.Boolean),
});
export type LoopState = Schema.Schema.Type<typeof LoopStateSchema>;
export type EncodedLoopState = Schema.Codec.Encoded<typeof LoopStateSchema>;

export const StartLoopInputSchema = Schema.Struct({
	name: LoopNameSchema,
	maxIterations: NonNegativeIntSchema,
	itemsPerIteration: NonNegativeIntSchema,
	reflectEvery: NonNegativeIntSchema,
	reflectInstructions: Schema.String,
});
export type StartLoopInput = Schema.Schema.Type<typeof StartLoopInputSchema>;

export const ResumeLoopInputSchema = Schema.Struct({
	name: LoopNameSchema,
});
export type ResumeLoopInput = Schema.Schema.Type<typeof ResumeLoopInputSchema>;

export const ArchiveLoopInputSchema = Schema.Struct({
	name: LoopNameSchema,
});
export type ArchiveLoopInput = Schema.Schema.Type<typeof ArchiveLoopInputSchema>;

export const LoopSummarySchema = Schema.Struct({
	name: LoopNameSchema,
	status: LoopStatusSchema,
	iteration: NonNegativeIntSchema,
	maxIterations: NonNegativeIntSchema,
	taskFile: Schema.NonEmptyString,
});
export type LoopSummary = Schema.Schema.Type<typeof LoopSummarySchema>;

const decodeLoopStateSchema = Schema.decodeUnknownEffect(LoopStateSchema);
const encodeLoopStateSchema = Schema.encodeUnknownEffect(LoopStateSchema);
const decodeLoopStateSchemaSync = Schema.decodeUnknownSync(LoopStateSchema);
const encodeLoopStateSchemaSync = Schema.encodeUnknownSync(LoopStateSchema);

const parseJsonUnknown = (input: string): Effect.Effect<unknown, RalphContractValidationError, never> =>
	Effect.try({
		try: () => JSON.parse(input) as unknown,
		catch: (error) => toContractValidationError("ralph.loop_state.json", error),
	});

function parseJsonUnknownSync(input: string): unknown {
	try {
		return JSON.parse(input) as unknown;
	} catch (error) {
		throw toContractValidationError("ralph.loop_state.json", error);
	}
}

export const decodeLoopState = (
	value: unknown,
): Effect.Effect<LoopState, RalphContractValidationError, never> =>
	decodeLoopStateSchema(value).pipe(
		Effect.mapError((error) =>
			toContractValidationError("ralph.loop_state", error),
		),
	);

export const encodeLoopState = (
	state: LoopState,
): Effect.Effect<EncodedLoopState, RalphContractValidationError, never> =>
	encodeLoopStateSchema(state).pipe(
		Effect.mapError((error) =>
			toContractValidationError("ralph.loop_state", error),
		),
	);

export const decodeLoopStateJson = (
	input: string,
): Effect.Effect<LoopState, RalphContractValidationError, never> =>
	parseJsonUnknown(input).pipe(Effect.flatMap(decodeLoopState));

export const encodeLoopStateJson = (
	state: LoopState,
): Effect.Effect<string, RalphContractValidationError, never> =>
	encodeLoopState(state).pipe(
		Effect.map((encoded) => JSON.stringify(encoded, null, 2)),
	);

export function decodeLoopStateSync(value: unknown): LoopState {
	try {
		return decodeLoopStateSchemaSync(value);
	} catch (error) {
		throw toContractValidationError("ralph.loop_state", error);
	}
}

export function encodeLoopStateSync(state: LoopState): EncodedLoopState {
	try {
		return encodeLoopStateSchemaSync(state);
	} catch (error) {
		throw toContractValidationError("ralph.loop_state", error);
	}
}

export function decodeLoopStateJsonSync(input: string): LoopState {
	return decodeLoopStateSync(parseJsonUnknownSync(input));
}

export function encodeLoopStateJsonSync(state: LoopState): string {
	return JSON.stringify(encodeLoopStateSync(state), null, 2);
}
