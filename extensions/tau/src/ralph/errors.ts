import { Schema } from "effect";

export class RalphContractValidationError extends Schema.TaggedErrorClass<RalphContractValidationError>()(
	"RalphContractValidationError",
	{
		reason: Schema.String,
		entity: Schema.String,
	},
) {}

export class RalphLoopNotFoundError extends Schema.TaggedErrorClass<RalphLoopNotFoundError>()(
	"RalphLoopNotFoundError",
	{
		loopName: Schema.String,
	},
) {}

export class RalphLoopAlreadyActiveError extends Schema.TaggedErrorClass<RalphLoopAlreadyActiveError>()(
	"RalphLoopAlreadyActiveError",
	{
		loopName: Schema.String,
	},
) {}

export class RalphLoopAlreadyCompletedError extends Schema.TaggedErrorClass<RalphLoopAlreadyCompletedError>()(
	"RalphLoopAlreadyCompletedError",
	{
		loopName: Schema.String,
	},
) {}

export class RalphInvalidLoopStateError extends Schema.TaggedErrorClass<RalphInvalidLoopStateError>()(
	"RalphInvalidLoopStateError",
	{
		loopName: Schema.String,
		reason: Schema.String,
	},
) {}

export class RalphControllerSessionMissingError extends Schema.TaggedErrorClass<RalphControllerSessionMissingError>()(
	"RalphControllerSessionMissingError",
	{
		loopName: Schema.String,
	},
) {}

export class RalphTaskFileMissingError extends Schema.TaggedErrorClass<RalphTaskFileMissingError>()(
	"RalphTaskFileMissingError",
	{
		loopName: Schema.String,
		taskFile: Schema.String,
	},
) {}

export class RalphLoopBlockedByActiveSubagentsError extends Schema.TaggedErrorClass<RalphLoopBlockedByActiveSubagentsError>()(
	"RalphLoopBlockedByActiveSubagentsError",
	{
		loopName: Schema.String,
	},
) {}

export class RalphSessionSwitchCancelledError extends Schema.TaggedErrorClass<RalphSessionSwitchCancelledError>()(
	"RalphSessionSwitchCancelledError",
	{
		loopName: Schema.String,
		targetSessionFile: Schema.String,
	},
) {}

export class RalphIterationSessionCreationCancelledError extends Schema.TaggedErrorClass<RalphIterationSessionCreationCancelledError>()(
	"RalphIterationSessionCreationCancelledError",
	{
		loopName: Schema.String,
		controllerSessionFile: Schema.String,
	},
) {}

export type RalphError =
	| RalphContractValidationError
	| RalphLoopNotFoundError
	| RalphLoopAlreadyActiveError
	| RalphLoopAlreadyCompletedError
	| RalphInvalidLoopStateError
	| RalphControllerSessionMissingError
	| RalphTaskFileMissingError
	| RalphLoopBlockedByActiveSubagentsError
	| RalphSessionSwitchCancelledError
	| RalphIterationSessionCreationCancelledError;
