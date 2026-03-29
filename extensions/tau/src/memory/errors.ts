import { Schema } from "effect";

import { MemoryEntry } from "./format.js";

export class MemoryEmptyContent extends Schema.TaggedErrorClass<MemoryEmptyContent>()(
	"MemoryEmptyContent",
	{},
) {}

export class MemoryEntryTooLarge extends Schema.TaggedErrorClass<MemoryEntryTooLarge>()(
	"MemoryEntryTooLarge",
	{
		scope: Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("user")]),
		limitChars: Schema.Number,
		entryChars: Schema.Number,
	},
) {}

export class MemoryNoMatch extends Schema.TaggedErrorClass<MemoryNoMatch>()(
	"MemoryNoMatch",
	{ id: Schema.String },
) {}

export class MemoryDuplicateEntry extends Schema.TaggedErrorClass<MemoryDuplicateEntry>()(
	"MemoryDuplicateEntry",
	{
		scope: Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("user")]),
		entry: MemoryEntry,
	},
) {}

export class MemoryFileError extends Schema.TaggedErrorClass<MemoryFileError>()(
	"MemoryFileError",
	{ reason: Schema.String },
) {}

export type MemoryMutationError =
	| MemoryEmptyContent
	| MemoryEntryTooLarge
	| MemoryNoMatch
	| MemoryDuplicateEntry
	| MemoryFileError;
