import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type BdIssue = {
	id?: string;
	title?: string;
	description?: string;
	status?: string;
	priority?: number | string;
	issue_type?: string;
	labels?: string[];
	created_at?: string;
	updated_at?: string;
	closed_at?: string;
	close_reason?: string;
	blocked_by_count?: number;
	blocked_by?: string[];
	dependency_count?: number;
	dependent_count?: number;
	[extra: string]: unknown;
};

type BdTreeNode = BdIssue & {
	depth?: number;
	parent_id?: string;
	truncated?: boolean;
};

type RenderKind =
	| "ready"
	| "list"
	| "blocked"
	| "show"
	| "dep_tree"
	| "create"
	| "update"
	| "close"
	| "init"
	| "onboard"
	| "sync"
	| "prime"
	| "help"
	| "unknown";

type BdToolDetails = {
	argv: string[];
	kind: RenderKind;
	isJson: boolean;
	json?: unknown;
	outputText?: string;
	stdout?: string;
	stderr?: string;
	code?: number;
};

type BdMessageDetails = BdToolDetails & { command: string };

const BD_MESSAGE_TYPE = "bd";

const bdParams = Type.Object({
	command: Type.String({
		description:
			"bd command to run. Omit the leading `bd` (it will be stripped if present). Examples: `ready`, `list`, `show tau-xyz`, `dep tree tau-xyz --direction up`.",
	}),
});

function statusMark(status: string | undefined): "done" | "todo" {
	if (status === "closed" || status === "done") return "done";
	return "todo";
}

function renderIssueInline(issue: BdIssue, theme: any): string {
	const check = statusMark(issue.status) === "done" ? theme.fg("success", "✔") : theme.fg("dim", "□");
	const id = (issue.id || "(no-id)").padEnd(12);
	const prio = `[${issue.priority !== undefined ? `P${issue.priority}` : "P?"}]`.padEnd(6);
	const type = `[${issue.issue_type || "?"}]`.padEnd(10);
	const status = `(${issue.status || "???"})`.padEnd(12);
	const title = issue.title || "(no title)";

	return `${check}  ${theme.fg("accent", id)}  ${theme.fg("muted", prio)}  ${theme.fg("muted", type)}  ${theme.fg("dim", status)}  ${theme.fg("toolOutput", title)}`;
}

function normalizeIssues(json: unknown): BdIssue[] {
	if (Array.isArray(json)) return json as BdIssue[];
	if (json && typeof json === "object") return [json as BdIssue];
	return [];
}

function renderIssuesBlock(issues: BdIssue[], options: { expanded: boolean }, theme: any): Text {
	const all = issues || [];
	const shown = options.expanded ? all : all.slice(0, 10);

	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);
	for (let i = 0; i < shown.length; i++) {
		const issue = shown[i]!;
		out += `\n${renderIssueInline(issue, theme)}`;
	}
	if (!options.expanded && all.length > shown.length) {
		out += `\n${theme.fg("dim", `… ${all.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderTreeBlock(nodes: BdTreeNode[], options: { expanded: boolean }, theme: any): Text {
	const all = nodes || [];
	const shown = options.expanded ? all : all.slice(0, 50);

	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);
	for (const node of shown) {
		const depth = typeof node.depth === "number" ? node.depth : 0;
		const indent = "  ".repeat(Math.max(0, depth));
		out += `\n${indent}${renderIssueInline(node, theme)}`;
	}
	if (!options.expanded && all.length > shown.length) {
		out += `\n${theme.fg("dim", `… ${all.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderFallback(kind: string, text: string, theme: any): Text {
	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);
	out += `\n${theme.fg("toolTitle", theme.bold(`bd ${kind}`))}`;
	out += `\n${theme.fg("warning", "No renderer for this command yet")}`;
	out += `\n\n${theme.fg("dim", text)}`;
	return new Text(out, 0, 0);
}

function stripLeadingPrompt(s: string): string {
	const t = s.trim();
	if (t.startsWith("$ ")) return t.slice(2).trim();
	if (t.startsWith("$")) return t.slice(1).trim();
	return t;
}

function shellSplit(input: string): string[] {
	// Minimal shell-style splitter: handles spaces, single/double quotes, and backslash escapes.
	const out: string[] = [];
	let current = "";
	let mode: "none" | "single" | "double" = "none";
	let escaped = false;

	const flush = () => {
		if (current.length > 0) out.push(current);
		current = "";
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\" && mode !== "single") {
			escaped = true;
			continue;
		}

		if (mode === "single") {
			if (ch === "'") mode = "none";
			else current += ch;
			continue;
		}

		if (mode === "double") {
			if (ch === '"') mode = "none";
			else current += ch;
			continue;
		}

		if (ch === "'") {
			mode = "single";
			continue;
		}
		if (ch === '"') {
			mode = "double";
			continue;
		}
		if (ch === " " || ch === "\n" || ch === "\t") {
			flush();
			continue;
		}

		current += ch;
	}

	flush();
	return out;
}

function stripLeadingBd(tokens: string[]): string[] {
	const t = [...tokens];
	while (t.length > 0 && t[0] === "") t.shift();
	if (t[0] === "bd") return t.slice(1);
	return t;
}

function commandKind(args: string[]): RenderKind {
	const nonFlags = args.filter((a) => !a.startsWith("-"));
	if (nonFlags.length === 0) return "unknown";

	if (args.includes("--help") || args.includes("-h")) return "help";

	const first = nonFlags[0];
	if (first === "ready") return "ready";
	if (first === "list") return "list";
	if (first === "blocked") return "blocked";
	if (first === "show") return "show";
	if (first === "create" || first === "new") return "create";
	if (first === "update") return "update";
	if (first === "close") return "close";
	if (first === "dep" && nonFlags[1] === "tree") return "dep_tree";
	if (first === "init") return "init";
	if (first === "onboard") return "onboard";
	if (first === "sync") return "sync";
	if (first === "prime") return "prime";
	if (first === "help") return "help";
	return "unknown";
}

function helpRewrite(args: string[]): string[] {
	// Allow `help` as a convenience and forward it to `--help`.
	// - `help` -> `--help`
	// - `help show` -> `show --help`
	const nonFlags = args.filter((a) => !a.startsWith("-"));
	if (nonFlags.length === 0) return args;
	if (nonFlags[0] !== "help") return args;

	if (nonFlags.length === 1) return ["--help"];
	return [nonFlags[1]!, "--help"];
}

function ensureJsonFlag(args: string[], kind: RenderKind): string[] {
	if (args.includes("--help") || args.includes("-h")) return args;
	if (args.includes("--json")) return args;

	// Only auto-enable JSON for commands we know how to render as issues.
	if (
		kind === "ready" ||
		kind === "list" ||
		kind === "blocked" ||
		kind === "show" ||
		kind === "dep_tree" ||
		kind === "create" ||
		kind === "update" ||
		kind === "close"
	) {
		return [...args, "--json"];
	}

	return args;
}

function withQuietFlag(args: string[], kind: RenderKind): string[] {
	// Quiet is useful to keep JSON clean, but should not hide output for setup
	// commands like init/onboard/sync/prime.
	if (args.includes("-q") || args.includes("--quiet")) return args;
	if (args.includes("--json")) return ["-q", ...args];
	if (
		kind === "ready" ||
		kind === "list" ||
		kind === "blocked" ||
		kind === "show" ||
		kind === "dep_tree" ||
		kind === "create" ||
		kind === "update" ||
		kind === "close"
	) {
		return ["-q", ...args];
	}
	return args;
}

function buildArgs(command: string): { args: string[]; kind: RenderKind } {
	const raw = stripLeadingPrompt(command);
	const tokens = shellSplit(raw);
	const withoutBd = stripLeadingBd(tokens);

	let args = helpRewrite(withoutBd);
	const kindBefore = commandKind(args);
	args = ensureJsonFlag(args, kindBefore);
	const kind = commandKind(args);
	args = withQuietFlag(args, kind);

	return { args, kind };
}

async function runBd(pi: ExtensionAPI, command: string, signal?: AbortSignal): Promise<BdToolDetails> {
	const { args, kind } = buildArgs(command);
	const res = await pi.exec("bd", args, { signal, timeout: 60_000 });

	const stdout = res.stdout || "";
	const stderr = res.stderr || "";
	const outputText = [stdout, stderr].filter(Boolean).join("").trim();

	// Only consider stdout JSON, and only if stdout is non-empty.
	let isJson = false;
	let parsedJson: unknown | undefined;
	if (stdout.trim().length > 0) {
		try {
			parsedJson = JSON.parse(stdout);
			isJson = true;
		} catch {
			parsedJson = undefined;
			isJson = false;
		}
	}

	return {
		argv: ["bd", ...args],
		kind,
		isJson,
		json: parsedJson,
		outputText,
		stdout,
		stderr,
		code: res.code,
	};
}

function renderBd(details: BdToolDetails, options: { expanded: boolean }, theme: any) {
	if (!details.isJson) {
		const text = details.outputText || "(no output)";

		if (details.kind === "help" || details.kind === "init" || details.kind === "onboard" || details.kind === "sync" || details.kind === "prime") {
			const mdTheme = getMarkdownTheme();
			return new Markdown(text, 0, 0, mdTheme);
		}

		return renderFallback(details.kind, text, theme);
	}

	const json = details.json;
	const issues = normalizeIssues(json);
	if (details.kind === "ready") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "list") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "blocked") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "show") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "dep_tree") return renderTreeBlock(issues as BdTreeNode[], options, theme);
	if (details.kind === "create") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "update") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "close") return renderIssuesBlock(issues, { expanded: true }, theme);

	return renderFallback("unknown", JSON.stringify(json, null, 2), theme);
}

export default function beads(pi: ExtensionAPI) {
	// Keep /bd command outputs out of LLM context.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m: any) => !(m?.role === "custom" && m?.customType === BD_MESSAGE_TYPE));
		return { messages: filtered };
	});

	pi.on("before_agent_start", async (event) => {
		const hint =
			"Beads integration: Prefer the `bd` tool over `bash` for Beads operations. The tool is a wrapper around the `bd` CLI and exists mainly for nice user rendering.";
		return { systemPrompt: `${hint}\n\n${event.systemPrompt}` };
	});

	const bdInitFlow = async (ctx: any): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/bd init requires interactive mode", "error");
			return;
		}

		ctx.ui.notify("Starting Beads init…", "info");

		pi.sendUserMessage(
			"Initialize Beads in this repository.\n\n" +
				"Rules:\n" +
				"- Use the `bd` tool (not bash) for bd operations.\n" +
				"- Use `command` and omit the leading `bd`.\n\n" +
				"Steps:\n" +
				"1) Ensure the global Beads skill folder is installed and up-to-date.\n" +
				"   - Local dir: ~/.pi/agent/skills/beads/\n" +
				"   - Upstream dir: https://github.com/steveyegge/beads/tree/main/claude-plugin/skills/beads\n" +
				"   - If missing or outdated, sync the whole folder (not just SKILL.md).\n" +
				"2) Run `init`.\n" +
				"3) Run `onboard` and follow the instructions it prints.\n" +
				"4) If onboard requires manual user steps, summarize them and ask the user to confirm when done.",
		);
	};

	pi.registerCommand("bd", {
		description: "bd wrapper: /bd <command> (plus /bd init)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const candidates: AutocompleteItem[] = [
				{ value: "ready", label: "ready", description: "List ready work" },
				{ value: "list", label: "list", description: "List issues" },
				{ value: "blocked", label: "blocked", description: "List blocked issues" },
				{ value: "show ", label: "show", description: "Show issue" },
				{ value: "dep tree ", label: "dep tree", description: "Dependency tree" },
				{ value: "init", label: "init", description: "Initialize repository" },
				{ value: "onboard", label: "onboard", description: "Onboarding instructions" },
				{ value: "sync", label: "sync", description: "Sync issues with git" },
				{ value: "prime", label: "prime", description: "Prime local cache" },
				{ value: "help", label: "help", description: "Show help" },
			];

			const normalized = prefix.toLowerCase();
			const filtered = candidates.filter((c) => c.value.toLowerCase().startsWith(normalized));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (!trimmed || trimmed === "help") {
				ctx.ui.notify("Usage: /bd init | /bd list | /bd ready | /bd blocked | /bd show <id> | /bd <anything>", "info");
				return;
			}

			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts[0] === "init") {
				await bdInitFlow(ctx);
				return;
			}

			// Run bd immediately and render output as a custom message.
			try {
				const details = await runBd(pi, trimmed);
				pi.sendMessage(
					{
						customType: BD_MESSAGE_TYPE,
						content: `bd ${trimmed}`,
						display: true,
						details: { ...details, command: trimmed } satisfies BdMessageDetails,
					},
					{ triggerTurn: false },
				);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});


	pi.registerMessageRenderer<BdMessageDetails>(BD_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details;
		if (!details) return new Text(theme.fg("dim", "(no bd details)"), 0, 0);
		return renderBd(details, options, theme);
	});

	pi.registerTool({
		name: "bd",
		label: "bd",
		description:
			"Wrapper around the `bd` (Beads) CLI created mainly to render output nicely for the user. Provide `command` and omit the leading `bd` (it will be stripped if present).\n\nCommon examples:\n- List all issues: `list`\n- List ready work (unblocked): `ready`\n- List blocked work: `blocked`\n- Show issue: `show tau-xxxx`\n- Create task: `create \"Title\" --type task --priority 2 --description \"...\"`\n- Create epic: `create \"Epic title\" --type epic --priority 1 --description \"...\"`\n- Update status: `update tau-xxxx --status in_progress`\n- Close issue: `close tau-xxxx --reason \"Done\"`\n- Init: `init`\n- Onboard: `onboard`\n- Sync: `sync`\n- Help: `help` (forwarded to `bd --help`) or `help show`",
		parameters: bdParams,

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const details = await runBd(pi, params.command, signal);

			if (details.code && details.code !== 0) {
				const errText = details.outputText || `bd exited with code ${details.code}`;
				return { content: [{ type: "text", text: errText }], details };
			}

			if (details.isJson) {
				return { content: [{ type: "json", json: details.json }], details };
			}

			return { content: [{ type: "text", text: details.outputText || "(no output)" }], details };
		},

		renderCall(args, theme) {
			const cmd = typeof args?.command === "string" ? args.command.trim() : "";
			const tokens = shellSplit(stripLeadingPrompt(cmd));
			const withoutBd = stripLeadingBd(tokens);

			const positional: string[] = [];
			const flags: Record<string, string | boolean> = {};

			for (let i = 0; i < withoutBd.length; i++) {
				const token = withoutBd[i]!;
				if (token.startsWith("-")) {
					const parts = token.split("=");
					const key = parts[0]!.replace(/^-+/, "");
					if (parts.length > 1) {
						flags[key] = parts.slice(1).join("=");
					} else {
						const next = withoutBd[i + 1];
						if (next && !next.startsWith("-")) {
							flags[key] = next;
							i++;
						} else {
							flags[key] = true;
						}
					}
				} else {
					positional.push(token);
				}
			}

			let out = theme.fg("toolTitle", theme.bold(`bd ${positional.join(" ")}`));
			for (const [key, value] of Object.entries(flags)) {
				let k = key;
				let v = value === true ? "true" : String(value);

				if (k === "json") {
					k = "output";
					v = "json";
				}

				out += `\n${theme.fg("muted", `${k}: ${v}`)}`;
			}

			return new Text(out, 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as BdToolDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "(no bd details)"), 0, 0);
			return renderBd(details, options, theme);
		},
	});
}
