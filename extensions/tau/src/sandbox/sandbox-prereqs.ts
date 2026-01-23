import { spawnSync } from "node:child_process";

export type SandboxPrereqCheckResult = {
	missingRequired: string[];
	missingOptional: string[];
};

export type CommandExistsFn = (cmd: string) => boolean;

export function defaultCommandExists(cmd: string): boolean {
	try {
		const res = spawnSync("which", [cmd], { stdio: "ignore" });
		return res.status === 0;
	} catch {
		return false;
	}
}

export function detectMissingSandboxDeps(opts: {
	platform: NodeJS.Platform;
	commandExists?: CommandExistsFn;
}): SandboxPrereqCheckResult {
	const commandExists = opts.commandExists ?? defaultCommandExists;

	const missingRequired: string[] = [];
	const missingOptional: string[] = [];

	if (opts.platform === "linux") {
		if (!commandExists("bwrap")) missingRequired.push("bwrap");
	}

	if (opts.platform === "darwin") {
		// sandbox-exec is shipped with macOS, but can be missing on unusual setups.
		if (!commandExists("sandbox-exec")) missingRequired.push("sandbox-exec");
		// ripgrep is optional but helps with some tooling and troubleshooting.
		if (!commandExists("rg")) missingOptional.push("rg");
	}

	return { missingRequired, missingOptional };
}

export function formatMissingDepsMessage(result: SandboxPrereqCheckResult): string {
	const parts: string[] = [];
	if (result.missingRequired.length > 0) {
		parts.push(`missing required deps: ${result.missingRequired.join(", ")}`);
	}
	if (result.missingOptional.length > 0) {
		parts.push(`missing optional deps: ${result.missingOptional.join(", ")}`);
	}
	return parts.join("; ");
}
