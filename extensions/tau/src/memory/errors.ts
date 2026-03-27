import { Schema } from "effect";

export class MemoryEmptyContent extends Schema.TaggedErrorClass<MemoryEmptyContent>()(
	"MemoryEmptyContent",
	{},
) {}

export class MemoryLimitExceeded extends Schema.TaggedErrorClass<MemoryLimitExceeded>()(
	"MemoryLimitExceeded",
	{
		currentChars: Schema.Number,
		limitChars: Schema.Number,
		entryChars: Schema.Number,
		currentEntries: Schema.Array(Schema.String),
	},
) {}

export class MemoryNoMatch extends Schema.TaggedErrorClass<MemoryNoMatch>()(
	"MemoryNoMatch",
	{ substring: Schema.String },
) {}

export class MemoryAmbiguousMatch extends Schema.TaggedErrorClass<MemoryAmbiguousMatch>()(
	"MemoryAmbiguousMatch",
	{
		matchCount: Schema.Number,
		previews: Schema.Array(Schema.String),
	},
) {}

export class MemoryDuplicateEntry extends Schema.TaggedErrorClass<MemoryDuplicateEntry>()(
	"MemoryDuplicateEntry",
	{},
) {}

export class MemoryFileError extends Schema.TaggedErrorClass<MemoryFileError>()(
	"MemoryFileError",
	{ reason: Schema.String },
) {}

export type MemoryMutationError =
	| MemoryEmptyContent
	| MemoryLimitExceeded
	| MemoryNoMatch
	| MemoryAmbiguousMatch
	| MemoryDuplicateEntry
	| MemoryFileError;
