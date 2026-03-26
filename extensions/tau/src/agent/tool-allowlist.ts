import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { Effect } from "effect";
import { AgentError } from "./services.js";
import type { AgentDefinition } from "./types.js";

export const STRUCTURED_OUTPUT_TOOL_NAME = "submit_result";

export function parseConfiguredToolNames(
	value: unknown,
	keyPath: string,
): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`${keyPath} must be an array`);
	}

	const seen = new Set<string>();
	const toolNames: string[] = [];
	for (const [index, entry] of value.entries()) {
		const entryPath = `${keyPath}[${index}]`;
		if (typeof entry !== "string") {
			throw new Error(`${entryPath} must be a string`);
		}
		if (entry.trim().length === 0) {
			throw new Error(`${entryPath} must not be empty`);
		}
		if (entry.trim() !== entry) {
			throw new Error(`${entryPath} must not contain leading or trailing whitespace`);
		}
		if (seen.has(entry)) {
			throw new Error(`${entryPath} duplicates "${entry}"`);
		}
		seen.add(entry);
		toolNames.push(entry);
	}

	return toolNames;
}

function getActiveToolNames(options: {
	agentName: string;
	configuredTools: readonly string[] | undefined;
	availableToolNames: readonly string[];
	structuredOutputRequired: boolean;
}): readonly string[] | undefined {
	if (options.configuredTools === undefined) {
		return undefined;
	}

	const activeToolNames = [...options.configuredTools];
	if (
		options.structuredOutputRequired &&
		!activeToolNames.includes(STRUCTURED_OUTPUT_TOOL_NAME)
	) {
		activeToolNames.push(STRUCTURED_OUTPUT_TOOL_NAME);
	}

	const available = new Set(options.availableToolNames);
	const unknownToolNames = activeToolNames.filter((name) => !available.has(name));
	if (unknownToolNames.length > 0) {
		const availableList = [...available].sort().join(", ");
		throw new AgentError({
			message:
				`Invalid tools for agent "${options.agentName}": ${unknownToolNames.join(", ")}. ` +
				`Available tools: ${availableList}`,
		});
	}

	return activeToolNames;
}

export function applyAgentToolAllowlist(
	session: AgentSession,
	definition: AgentDefinition,
	resultSchema: unknown | undefined,
): Effect.Effect<void, AgentError> {
	return Effect.try({
		try: () => {
			const availableToolNames = session.getAllTools().map((tool) => tool.name);
			const activeToolNames = getActiveToolNames({
				agentName: definition.name,
				configuredTools: definition.tools,
				availableToolNames,
				structuredOutputRequired: resultSchema !== undefined,
			});

			if (activeToolNames !== undefined) {
				session.setActiveToolsByName([...activeToolNames]);
			}
		},
		catch: (cause) =>
			cause instanceof AgentError
				? cause
				: new AgentError({ message: cause instanceof Error ? cause.message : String(cause) }),
	});
}
