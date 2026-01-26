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
	"sed", // only with -n flag checked separately
	"awk",
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
	
	// Rust/Node/Python (read-only subcommands checked separately)
	"cargo",
	"npm",
	"yarn",
	"pnpm",
	"pip",
	"python",
	"node",
]);

/** Git subcommands that are safe (read-only) */
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"tag",
	"remote",
	"config",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"describe",
	"shortlog",
	"blame",
	"reflog",
	"stash", // stash list is safe
]);

/** Cargo subcommands that are safe */
const SAFE_CARGO_SUBCOMMANDS = new Set([
	"check",
	"clippy",
	"fmt",
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
	"audit",
	"--version",
	"-v",
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
	const shellMatch = cmdToCheck.match(/^(?:bash|sh|zsh)\s+(?:-[a-z]+\s+)*(?:-c\s+)?['"]?(.+?)['"]?$/i);
	if (shellMatch && shellMatch[1]) {
		cmdToCheck = shellMatch[1];
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
		return segments.every(seg => isSafeCommand(seg));
	}
	
	// Check for && or || chains
	if (cmdToCheck.includes("&&") || cmdToCheck.includes("||") || cmdToCheck.includes(";")) {
		const segments = cmdToCheck.split(/\s*(?:&&|\|\||;)\s*/);
		return segments.every(seg => isSafeCommand(seg));
	}
	
	// Git - check subcommand
	if (baseName === "git") {
		const subcommand = args[0]?.toLowerCase();
		return subcommand ? SAFE_GIT_SUBCOMMANDS.has(subcommand) : false;
	}
	
	// Cargo - check subcommand
	if (baseName === "cargo") {
		const subcommand = args[0]?.toLowerCase();
		return subcommand ? SAFE_CARGO_SUBCOMMANDS.has(subcommand) : false;
	}
	
	// npm/yarn/pnpm - check subcommand
	if (baseName === "npm" || baseName === "yarn" || baseName === "pnpm") {
		const subcommand = args[0]?.toLowerCase();
		return subcommand ? SAFE_NPM_SUBCOMMANDS.has(subcommand) : false;
	}
	
	// Find - check for unsafe options
	if (baseName === "find") {
		return !args.some(arg => UNSAFE_FIND_OPTIONS.has(arg.toLowerCase()));
	}
	
	// sed - only safe with -n (print mode)
	if (baseName === "sed") {
		return args.includes("-n");
	}
	
	// python/node - only safe with --version or -c for simple expressions
	if (baseName === "python" || baseName === "python3" || baseName === "node") {
		if (args.includes("--version") || args.includes("-V")) {
			return true;
		}
		// Very conservative - most python/node commands could have side effects
		return false;
	}
	
	// Check base safe commands
	return SAFE_COMMANDS.has(baseName);
}
