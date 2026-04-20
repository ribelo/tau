import { Schema } from "effect";

import { MemoryEntry } from "./format.js";

export class MemoryEmptyContent extends Schema.TaggedErrorClass<MemoryEmptyContent>()(
	"MemoryEmptyContent",
	{},
) {}

export class MemoryEmptySummary extends Schema.TaggedErrorClass<MemoryEmptySummary>()(
	"MemoryEmptySummary",
	{},
) {}

export class MemoryEntryTooLarge extends Schema.TaggedErrorClass<MemoryEntryTooLarge>()(
	"MemoryEntryTooLarge",
	{
		scope: Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("user")]),
		limitChars: Schema.Number,
		currentChars: Schema.Number,
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

export class MemoryDuplicateSummary extends Schema.TaggedErrorClass<MemoryDuplicateSummary>()(
	"MemoryDuplicateSummary",
	{
		scope: Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("user")]),
		entry: MemoryEntry,
	},
) {}

export class MemorySummaryMatchesContent extends Schema.TaggedErrorClass<MemorySummaryMatchesContent>()(
	"MemorySummaryMatchesContent",
	{},
) {}

export class MemoryFileError extends Schema.TaggedErrorClass<MemoryFileError>()(
	"MemoryFileError",
	{ reason: Schema.String },
) {}

export type MemoryMutationError =
	| MemoryEmptyContent
	| MemoryEmptySummary
	| MemoryEntryTooLarge
	| MemoryNoMatch
	| MemoryDuplicateEntry
	| MemoryDuplicateSummary
	| MemorySummaryMatchesContent
	| MemoryFileError;
