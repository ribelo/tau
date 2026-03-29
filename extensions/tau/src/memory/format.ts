export type MemoryScope = "project" | "global" | "user";

export interface MemoryBucketSnapshot {
	readonly bucket: MemoryScope;
	readonly path: string;
	readonly entries: readonly string[];
	readonly chars: number;
	readonly limitChars: number;
	readonly usagePercent: number;
}

export interface MemorySnapshot {
	readonly project: MemoryBucketSnapshot;
	readonly global: MemoryBucketSnapshot;
	readonly user: MemoryBucketSnapshot;
}

export const ENTRY_DELIMITER = "\n§\n";

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
