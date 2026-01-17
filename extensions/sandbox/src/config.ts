export type SandboxConfig = {
	filesystemMode: "read-only" | "workspace-write" | "danger-full-access";
	networkMode: "deny" | "allowlist" | "allow-all";
	approvalPolicy: "never" | "ask" | "on-failure";
};

export function ensureUserDefaults(): void {
	// Placeholder for future: write defaults into user config.
	// Kept as no-op to preserve current behavior without filesystem side effects.
}

export function computeEffectiveConfig(opts: {
	workspaceRoot: string;
	sessionOverride?: Partial<SandboxConfig>;
}): SandboxConfig {
	return {
		filesystemMode: opts.sessionOverride?.filesystemMode ?? "read-only",
		networkMode: opts.sessionOverride?.networkMode ?? "deny",
		approvalPolicy: opts.sessionOverride?.approvalPolicy ?? "ask",
	};
}
