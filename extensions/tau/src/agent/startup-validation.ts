import { Cause, Effect, Exit } from "effect";
import { AgentRegistry, AgentRegistryConfigError } from "./agent-registry.js";

interface StartupValidationHandlers {
	readonly notify: (message: string) => void | Promise<void>;
	readonly log: (message: string) => void;
	readonly exit: (code: number) => never;
}

const WORKER_AVAILABLE_TOOL_NAMES = [
	"agent",
	"apply_patch",
	"bash",
	"backlog",
	"crawling_exa",
	"edit",
	"find",
	"get_code_context_exa",
	"grep",
	"ls",
	"memory",
	"read",
	"web_search_exa",
	"write",
] as const;

function formatList(values: readonly string[]): string {
	return [...values].sort().join(", ");
}

function validateResolvedAgentConfiguration(
	registry: AgentRegistry,
): Effect.Effect<void, AgentRegistryConfigError> {
	const availableTools = new Set<string>(WORKER_AVAILABLE_TOOL_NAMES);

	return Effect.forEach(registry.names(), (name) =>
		Effect.gen(function* () {
			const definition = registry.resolve(name);
			if (!definition) {
				return;
			}

			if (definition.tools !== undefined) {
				const invalidTools = [
					...new Set(definition.tools.filter((tool) => !availableTools.has(tool))),
				];
				if (invalidTools.length > 0) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message:
								`Invalid tools for agent "${name}": ${invalidTools.join(", ")}. ` +
								`Available tools: ${formatList(WORKER_AVAILABLE_TOOL_NAMES)}`,
						}),
					);
				}
			}

			if (definition.spawns !== undefined && definition.spawns !== "*") {
				const invalidSpawns = [
					...new Set(definition.spawns.filter((spawn) => !registry.has(spawn))),
				];
				if (invalidSpawns.length > 0) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message:
								`Invalid spawns for agent "${name}": ${invalidSpawns.join(", ")}. ` +
								`Available agents: ${formatList(registry.names())}`,
						}),
					);
				}
			}
		}),
	).pipe(Effect.asVoid);
}

function formatStartupValidationError(error: unknown): string {
	const details =
		error instanceof AgentRegistryConfigError
			? error.message
			: error instanceof Error
				? error.message
				: String(error);

	return `pi failed to start: invalid agent configuration detected.\n${details}`;
}

export async function validateAgentDefinitionsAtStartup(
	cwd: string,
	handlers?: Partial<StartupValidationHandlers>,
): Promise<void> {
	const exit = await Effect.runPromiseExit(
		AgentRegistry.load(cwd).pipe(Effect.flatMap(validateResolvedAgentConfiguration)),
	);
	if (Exit.isFailure(exit)) {
		const error = Cause.squash(exit.cause);
		const message = formatStartupValidationError(error);
		await handlers?.notify?.(message);
		(handlers?.log ?? console.error)(message);
		(handlers?.exit ?? ((code: number): never => process.exit(code)))(1);
	}
}
