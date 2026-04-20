import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function uniqueToolNames(toolNames: ReadonlyArray<string>): ReadonlyArray<string> {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const toolName of toolNames) {
		if (seen.has(toolName)) {
			continue;
		}
		seen.add(toolName);
		unique.push(toolName);
	}
	return unique;
}

export function setToolsEnabled(
	pi: ExtensionAPI,
	toolNames: ReadonlyArray<string>,
	enabled: boolean,
): void {
	const uniqueNames = uniqueToolNames(toolNames);
	if (uniqueNames.length === 0) {
		return;
	}

	const activeTools = pi.getActiveTools();
	const activeSet = new Set(activeTools);

	if (enabled) {
		const nextTools = [...activeTools];
		let changed = false;

		for (const toolName of uniqueNames) {
			if (activeSet.has(toolName)) {
				continue;
			}
			changed = true;
			nextTools.push(toolName);
			activeSet.add(toolName);
		}

		if (changed) {
			pi.setActiveTools(nextTools);
		}
		return;
	}

	let changed = false;
	for (const toolName of uniqueNames) {
		if (activeSet.has(toolName)) {
			changed = true;
			break;
		}
	}
	if (!changed) {
		return;
	}

	const denied = new Set(uniqueNames);
	const nextTools = activeTools.filter((toolName) => !denied.has(toolName));
	pi.setActiveTools(nextTools);
}

export function setToolEnabled(pi: ExtensionAPI, toolName: string, enabled: boolean): void {
	setToolsEnabled(pi, [toolName], enabled);
}
