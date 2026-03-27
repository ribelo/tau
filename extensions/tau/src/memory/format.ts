export type MemoryBucket = "memory" | "user";

export const ENTRY_DELIMITER = "\n§\n";

const HEADER_SEPARATOR = "═".repeat(46);
const numberFormatter = new Intl.NumberFormat("en-US");

function usagePercent(currentChars: number, charLimit: number): number {
	return charLimit > 0 ? Math.floor((currentChars / charLimit) * 100) : 0;
}

function formatUsage(currentChars: number, charLimit: number): string {
	return `${usagePercent(currentChars, charLimit)}% — ${numberFormatter.format(currentChars)}/${numberFormatter.format(charLimit)} chars`;
}

function promptBlockTitle(bucket: MemoryBucket): string {
	return bucket === "user"
		? "USER PROFILE (who the user is)"
		: "MEMORY (your personal notes)";
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

export function renderPromptBlock(
	bucket: MemoryBucket,
	entries: readonly string[],
	charLimit: number,
): string {
	if (entries.length === 0) {
		return "";
	}

	const content = joinEntries(entries);
	const header = `${promptBlockTitle(bucket)} [${formatUsage(content.length, charLimit)}]`;

	return `${HEADER_SEPARATOR}\n${header}\n${HEADER_SEPARATOR}\n${content}`;
}
