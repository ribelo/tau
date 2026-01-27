import * as Schema from "@effect/schema/Schema";

export const Status = Schema.Union(
	Schema.Struct({ state: Schema.Literal("pending") }),
	Schema.Struct({ 
		state: Schema.Literal("running"),
		turns: Schema.optional(Schema.Number),
		toolCalls: Schema.optional(Schema.Number),
		workedMs: Schema.optional(Schema.Number),
	}),
	Schema.Struct({
		state: Schema.Literal("completed"),
		message: Schema.optional(Schema.String),
		structured_output: Schema.optional(Schema.Unknown),
		turns: Schema.optional(Schema.Number),
		toolCalls: Schema.optional(Schema.Number),
		workedMs: Schema.optional(Schema.Number),
	}),
	Schema.Struct({
		state: Schema.Literal("failed"),
		reason: Schema.String,
		turns: Schema.optional(Schema.Number),
		toolCalls: Schema.optional(Schema.Number),
		workedMs: Schema.optional(Schema.Number),
	}),
	Schema.Struct({ state: Schema.Literal("shutdown") }),
);

export type Status = Schema.Schema.Type<typeof Status>;

export const isFinal = (status: Status): boolean =>
	status.state === "completed" ||
	status.state === "failed" ||
	status.state === "shutdown";

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
