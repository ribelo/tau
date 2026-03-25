/**
 * Simple safe command detection for "unless-trusted" policy.
 *
 * This is a pragmatic implementation - not full shell parsing like Codex,
 * but covers common read-only commands that are safe to auto-approve.
 */

/** Commands that are always safe (read-only, no side effects) */
const SAFE_COMMANDS = new Set([
	// File viewing
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"bat",

	// Listing/finding
	"ls",
	"ll",
	"la",
	"tree",
	"pwd",
	"which",
	"whereis",
	"type",
	"file",
	"stat",

	// Text processing (read-only)
	"grep",
	"rg",
	"ag",
	"ack",
	"wc",
	"sort",
	"uniq",
	"cut",
	"tr",
	"sed", // only with -n + range pattern checked separately
	"jq",
	"yq",

	// System info
	"echo",
	"printf",
	"date",
	"whoami",
	"id",
	"uname",
	"hostname",
	"uptime",
	"free",
	"df",
	"du",
	"env",
	"printenv",

	// Development read-only
	"diff",
	"cmp",
	"md5sum",
	"sha256sum",
	"xxd",
	"od",
	"hexdump",
]);

/** Git subcommands that are safe (read-only) */
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"cat-file",
	"tag",
	"remote",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"describe",
	"shortlog",
	"blame",
	"reflog",
]);

/** Git flags that can execute arbitrary commands — reject if present */
const UNSAFE_GIT_FLAGS = new Set([
	"-c",
	"--config-env",
	"--output",
	"--ext-diff",
	"--textconv",
	"--exec",
	"--paginate",
]);

/** Git branch flags that keep it read-only */
const SAFE_GIT_BRANCH_FLAGS = new Set([
	"--list",
	"-l",
	"--show-current",
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-v",
	"-vv",
	"--verbose",
]);

/** Cargo subcommands that are truly read-only (no build script execution) */
const SAFE_CARGO_SUBCOMMANDS = new Set([
	"tree",
	"metadata",
	"version",
	"--version",
]);

/** npm/yarn/pnpm subcommands that are safe */
const SAFE_NPM_SUBCOMMANDS = new Set([
	"list",
	"ls",
	"view",
	"info",
	"outdated",
	"--version",
	"-v",
]);

/** rg flags that execute external commands */
const UNSAFE_RG_FLAGS = new Set([
	"--pre",
	"--hostname-bin",
	"-z",
	"--search-zip",
]);

/** Find options that make it unsafe */
const UNSAFE_FIND_OPTIONS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

/**
 * Check if a command is "safe" (read-only, no side effects).
 * Used by "unless-trusted" policy to auto-approve safe commands.
 *
 * @param command - The full command string (e.g., "ls -la" or "git status")
 * @returns true if command appears safe to run without approval
 */
export function isSafeCommand(command: string): boolean {
	// Basic parsing - extract first word and subsequent args
	const trimmed = command.trim();
	if (!trimmed) return false;

	// Handle common shell wrappers
	let cmdToCheck = trimmed;

	// Strip leading bash -c / bash -lc / sh -c wrapper
	const shellMatch = cmdToCheck.match(
		/^(?:bash|sh|zsh)\s+(?:-[a-z]+\s+)*(?:-c\s+)?['"]?(.+?)['"]?$/i,
	);
	if (shellMatch && shellMatch[1]) {
		cmdToCheck = shellMatch[1];
	}

	// Reject command substitution and subshells — they can smuggle arbitrary commands
	if (/\$\(/.test(cmdToCheck) || /`/.test(cmdToCheck) || /\$\{/.test(cmdToCheck)) {
		return false;
	}

	// Split into words (simple split, doesn't handle all quoting)
	const words = cmdToCheck.split(/\s+/).filter(Boolean);
	if (words.length === 0) return false;

	const firstWord = words[0];
	if (!firstWord) return false;
	const cmd = firstWord.toLowerCase();
	const args = words.slice(1);

	// Extract base command name (strip path)
	const baseName = cmd.split("/").pop() || cmd;

	// Check redirections - any > or >> makes it unsafe
	if (cmdToCheck.includes(">") || cmdToCheck.includes(">>")) {
		return false;
	}

	// Check for pipes to unsafe commands
	if (cmdToCheck.includes("|")) {
		// For piped commands, check each segment
		const segments = cmdToCheck.split(/\s*\|\s*/);
		return segments.every((seg) => isSafeCommand(seg));
	}

	// Check for && or || chains
	if (cmdToCheck.includes("&&") || cmdToCheck.includes("||") || cmdToCheck.includes(";")) {
		const segments = cmdToCheck.split(/\s*(?:&&|\|\||;)\s*/);
		return segments.every((seg) => isSafeCommand(seg));
	}

	// Git - check subcommand and reject dangerous flags
	if (baseName === "git") {
		if (args.some((a) => UNSAFE_GIT_FLAGS.has(a.toLowerCase()) || a.startsWith("--config-env="))) {
			return false;
		}
		const subcommand = args[0]?.toLowerCase();
		if (!subcommand) return false;
		// git branch is only safe with listing flags (not create/delete)
		if (subcommand === "branch") {
			const branchArgs = args.slice(1);
			return branchArgs.every((a) => SAFE_GIT_BRANCH_FLAGS.has(a) || a.startsWith("--format="));
		}
		return SAFE_GIT_SUBCOMMANDS.has(subcommand);
	}

	// Cargo - check subcommand (check/clippy/build run build scripts — not safe)
	if (baseName === "cargo") {
		const subcommand = args[0]?.toLowerCase();
		return subcommand ? SAFE_CARGO_SUBCOMMANDS.has(subcommand) : false;
	}

	// npm/yarn/pnpm - check subcommand (audit/run can execute arbitrary code)
	if (baseName === "npm" || baseName === "yarn" || baseName === "pnpm") {
		const subcommand = args[0]?.toLowerCase();
		return subcommand ? SAFE_NPM_SUBCOMMANDS.has(subcommand) : false;
	}

	// rg - check for flags that execute external commands
	if (baseName === "rg") {
		return !args.some((a) => UNSAFE_RG_FLAGS.has(a.toLowerCase()));
	}

	// Find - check for unsafe options
	if (baseName === "find") {
		return !args.some((arg) => UNSAFE_FIND_OPTIONS.has(arg.toLowerCase()));
	}

	// sed - only safe with -n and a range print pattern (e.g. sed -n '1,5p')
	if (baseName === "sed") {
		if (!args.includes("-n")) return false;
		const scriptArgs = args.filter((a) => a !== "-n" && !a.startsWith("-"));
		return scriptArgs.length <= 1 && scriptArgs.every((a) => /^'?\d+(,\d+)?p'?$/.test(a));
	}

	// python/node - only --version is safe
	if (baseName === "python" || baseName === "python3" || baseName === "node") {
		return args.includes("--version") || args.includes("-V");
	}

	// Check base safe commands
	return SAFE_COMMANDS.has(baseName);
}
