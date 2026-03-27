import { Schema } from "effect";

export class SkillNotFound extends Schema.TaggedErrorClass<SkillNotFound>()(
	"SkillNotFound",
	{ name: Schema.String },
) {}

export class SkillAlreadyExists extends Schema.TaggedErrorClass<SkillAlreadyExists>()(
	"SkillAlreadyExists",
	{
		name: Schema.String,
		path: Schema.String,
	},
) {}

export class SkillInvalidName extends Schema.TaggedErrorClass<SkillInvalidName>()(
	"SkillInvalidName",
	{
		name: Schema.String,
		reason: Schema.String,
	},
) {}

export class SkillInvalidContent extends Schema.TaggedErrorClass<SkillInvalidContent>()(
	"SkillInvalidContent",
	{ reason: Schema.String },
) {}

export class SkillFileError extends Schema.TaggedErrorClass<SkillFileError>()(
	"SkillFileError",
	{ reason: Schema.String },
) {}

export class SkillSecurityViolation extends Schema.TaggedErrorClass<SkillSecurityViolation>()(
	"SkillSecurityViolation",
	{ reason: Schema.String },
) {}

export class SkillPatchFailed extends Schema.TaggedErrorClass<SkillPatchFailed>()(
	"SkillPatchFailed",
	{ reason: Schema.String },
) {}

export type SkillMutationError =
	| SkillNotFound
	| SkillAlreadyExists
	| SkillInvalidName
	| SkillInvalidContent
	| SkillFileError
	| SkillSecurityViolation
	| SkillPatchFailed;
