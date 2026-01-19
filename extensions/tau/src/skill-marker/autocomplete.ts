import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "@mariozechner/pi-tui";

export type SkillCandidate = { name: string; description: string };

const SKILL_AUTOCOMPLETE_REGEX = /(?:^|\s)(\$[a-z0-9-]*)$/;

export class SkillMarkerAutocompleteProvider implements AutocompleteProvider {
	private base: AutocompleteProvider;
	private getCandidates: () => SkillCandidate[];

	constructor(base: AutocompleteProvider, getCandidates: () => SkillCandidate[]) {
		this.base = base;
		this.getCandidates = getCandidates;
	}

	setBase(base: AutocompleteProvider): void {
		this.base = base;
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const m = textBeforeCursor.match(SKILL_AUTOCOMPLETE_REGEX);
		if (m) {
			const prefix = m[1] ?? "$";
			const query = prefix.slice(1);
			const filtered = fuzzyFilter(this.getCandidates(), query, (c) => c.name).slice(0, 30);
			if (filtered.length === 0) return null;
			return {
				items: filtered.map((c) => ({ value: c.name, label: c.name, description: c.description })),
				prefix,
			};
		}

		return this.base.getSuggestions(lines, cursorLine, cursorCol);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (prefix.startsWith("$")) {
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);

			const insertion = `$${item.value}`;
			const newLine = beforePrefix + insertion + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + insertion.length,
			};
		}

		return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

export function shouldAutoTriggerSkillAutocomplete(
	editor: {
		isShowingAutocomplete: () => boolean;
		getCursor: () => { line: number; col: number };
		getLines: () => string[];
	},
	typedChar: string,
): boolean {
	// Only for single-character inserts (typing).
	if (typedChar.length !== 1) return false;
	// Trigger when typing '$' or continuing a $token.
	if (typedChar !== "$" && !/[a-z0-9-]/.test(typedChar)) return false;
	if (editor.isShowingAutocomplete()) return false;

	const cursor = editor.getCursor();
	const lines = editor.getLines();
	if (!cursor || !lines) return false;

	const currentLine = lines[cursor.line] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursor.col);
	return SKILL_AUTOCOMPLETE_REGEX.test(textBeforeCursor);
}

