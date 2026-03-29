import { DateTime, Schema } from "effect";
import { nanoid } from "nanoid";

export type MemoryScope = "project" | "global" | "user";

const ID_SIZE = 12;
const NANO_ID_PATTERN = /^[A-Za-z0-9_-]{12,}$/u;

export const MemoryEntryId = Schema.String.check(
	Schema.makeFilter((value) => NANO_ID_PATTERN.test(value) || "expected a nanoid"),
).pipe(Schema.brand("MemoryEntryId"));

export type MemoryEntryId = typeof MemoryEntryId.Type;
export type MemoryTimestamp = typeof Schema.DateTimeUtcFromString.Type;

const MemoryEntryContent = Schema.String.check(
	Schema.makeFilter(
		(value) => value.trim().length > 0 || "memory content must not be empty",
	),
);

export class MemoryEntry extends Schema.Class<MemoryEntry>("MemoryEntry")({
	id: MemoryEntryId,
	content: MemoryEntryContent,
	createdAt: Schema.DateTimeUtcFromString,
	updatedAt: Schema.DateTimeUtcFromString,
}) {}

export type MemoryEntryJson = typeof MemoryEntry.Encoded;

export interface CreateMemoryEntryOptions {
	readonly id?: string;
	readonly now?: MemoryTimestamp;
	readonly createdAt?: MemoryTimestamp;
	readonly updatedAt?: MemoryTimestamp;
}

export interface LegacyMemoryMigrationOptions {
	readonly now?: MemoryTimestamp;
	readonly createId?: () => string;
}

export interface MemoryBucketSnapshot {
	readonly bucket: MemoryScope;
	readonly path: string;
	readonly entries: readonly string[];
	readonly chars: number;
	readonly limitChars: number;
	readonly usagePercent: number;
}

export interface MemoryBucketEntriesSnapshot {
	readonly bucket: MemoryScope;
	readonly path: string;
	readonly entries: readonly MemoryEntry[];
	readonly chars: number;
	readonly limitChars: number;
	readonly usagePercent: number;
}

export interface MemorySnapshot {
	readonly project: MemoryBucketSnapshot;
	readonly global: MemoryBucketSnapshot;
	readonly user: MemoryBucketSnapshot;
}

export interface MemoryEntriesSnapshot {
	readonly project: MemoryBucketEntriesSnapshot;
	readonly global: MemoryBucketEntriesSnapshot;
	readonly user: MemoryBucketEntriesSnapshot;
}

export const ENTRY_DELIMITER = "\n§\n";

const decodeMemoryEntry = Schema.decodeUnknownSync(MemoryEntry);
const encodeMemoryEntry = Schema.encodeUnknownSync(MemoryEntry);

export function normalizeMemoryContent(value: string): string {
	return value.replace(/\r\n?/gu, "\n").trim();
}

function formatTimestamp(value: MemoryTimestamp): string {
	return DateTime.formatIso(value);
}

export function createMemoryEntry(
	content: string,
	options: CreateMemoryEntryOptions = {},
): MemoryEntry {
	const createdAt = options.createdAt ?? options.now ?? DateTime.nowUnsafe();
	const updatedAt = options.updatedAt ?? createdAt;

	return decodeMemoryEntry({
		id: options.id ?? nanoid(ID_SIZE),
		content: normalizeMemoryContent(content),
		createdAt: formatTimestamp(createdAt),
		updatedAt: formatTimestamp(updatedAt),
	});
}

export function serializeMemoryEntry(entry: MemoryEntry): string {
	return JSON.stringify(encodeMemoryEntry(entry));
}

export function serializeMemoryEntries(entries: readonly MemoryEntry[]): string {
	return entries.map(serializeMemoryEntry).join("\n");
}

export function parseMemoryEntry(line: string): MemoryEntry {
	const trimmed = line.trim();
	if (!trimmed) {
		throw new Error("Cannot parse an empty JSONL memory entry");
	}

	const parsed = JSON.parse(trimmed) as unknown;
	return decodeMemoryEntry(parsed);
}

export function parseMemoryEntries(raw: string): MemoryEntry[] {
	if (!raw.trim()) {
		return [];
	}

	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map(parseMemoryEntry);
}

export function migrateLegacyEntries(
	raw: string,
	options: LegacyMemoryMigrationOptions = {},
): MemoryEntry[] {
	const timestamp = options.now ?? DateTime.nowUnsafe();

	return parseEntries(raw).map((content) =>
		createMemoryEntry(content, {
			createdAt: timestamp,
			updatedAt: timestamp,
			...(options.createId ? { id: options.createId() } : {}),
		}),
	);
}

export function migrateLegacyMarkdownToJsonl(
	raw: string,
	options: LegacyMemoryMigrationOptions = {},
): string {
	return serializeMemoryEntries(migrateLegacyEntries(raw, options));
}

export function parseEntries(raw: string): string[] {
	if (!raw.trim()) {
		return [];
	}

	return raw
		.split(ENTRY_DELIMITER)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function joinEntries(entries: readonly string[]): string {
	return entries.join(ENTRY_DELIMITER);
}

export function charCount(entries: readonly string[]): number {
	return joinEntries(entries).length;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function bucketTag(bucket: MemoryScope): string {
	return `${bucket}_memory`;
}

function snapshotBuckets(snapshot: MemorySnapshot): readonly MemoryBucketSnapshot[] {
	return [snapshot.project, snapshot.global, snapshot.user];
}

function renderBucketXml(bucket: MemoryBucketSnapshot): string {
	const lines = [
		`<${bucketTag(bucket.bucket)} path="${escapeXml(bucket.path)}" entries="${bucket.entries.length}" chars="${bucket.chars}" limit="${bucket.limitChars}" usage_percent="${bucket.usagePercent}">`,
	];
	const content = joinEntries(bucket.entries);
	if (content.length > 0) {
		lines.push(escapeXml(content));
	}
	lines.push(`</${bucketTag(bucket.bucket)}>`);
	return lines.join("\n");
}

export function renderMemorySnapshotXml(
	snapshot: MemorySnapshot,
	options: { readonly includeEmpty?: boolean } = {},
): string {
	const includeEmpty = options.includeEmpty ?? false;
	const buckets = snapshotBuckets(snapshot).filter((bucket) => includeEmpty || bucket.entries.length > 0);
	if (buckets.length === 0) {
		return "";
	}

	return ["<memory_snapshot>", ...buckets.map(renderBucketXml), "</memory_snapshot>"].join("\n");
}
