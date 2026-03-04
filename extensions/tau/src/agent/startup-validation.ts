import { AgentRegistry, AgentRegistryConfigError } from "./agent-registry.js";

interface StartupValidationHandlers {
	readonly log: (message: string) => void;
	readonly exit: (code: number) => never;
}

function formatStartupValidationError(error: unknown): string {
	const details =
		error instanceof AgentRegistryConfigError
			? error.message
			: error instanceof Error
				? error.message
				: String(error);

	return `pi failed to start: invalid agent definition markdown detected.\n${details}`;
}

export function validateAgentDefinitionsAtStartup(
	cwd: string,
	handlers?: Partial<StartupValidationHandlers>,
): void {
	try {
		AgentRegistry.load(cwd);
	} catch (error) {
		const message = formatStartupValidationError(error);
		(handlers?.log ?? console.error)(message);
		(handlers?.exit ?? ((code: number): never => process.exit(code)))(1);
	}
}
