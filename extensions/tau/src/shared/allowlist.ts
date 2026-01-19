export function parseAllowlist(input: string): string[] {
	return Array.from(
		new Set(
			input
				.split(/[,\s]+/)
				.map((value) => value.trim())
				.filter(Boolean),
		),
	).sort();
}

export function formatAllowlist(list: string[]): string {
	if (list.length === 0) return "(none)";
	if (list.length <= 3) return list.join(", ");
	return `${list.length} domains`;
}

export function normalizeAllowlist(list: string[] | undefined): string[] {
	if (!list) return [];
	return Array.from(new Set(list.map((s) => String(s).trim()).filter(Boolean))).sort();
}

export function intersectAllowlist(a: string[], b: string[]): string[] {
	if (a.length === 0 || b.length === 0) return [];
	const set = new Set(a);
	return Array.from(new Set(b.filter((x) => set.has(x)))).sort();
}
