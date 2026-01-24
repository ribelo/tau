import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import type { TauState } from "../shared/state.js";

type Theme = {
	fg: (key: string, s: string) => string;
	bold: (s: string) => string;
};

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
	| "dep_list"
	| "dep_add"
	| "dep_remove"
	| "dep_cycles"
	| "create"
	| "update"
	| "close"
	| "reopen"
	| "delete"
	| "search"
	| "stale"
	| "defer"
	| "undefer"
	| "pin"
	| "unpin"
	| "status"
	| "comment"
	| "comments"
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
	cwd: Type.Optional(Type.String({
		description: "Optional current working directory to run the command in.",
	})),
});

function statusKind(issue: BdIssue): "done" | "closed" | "in_progress" | "deferred" | "open" | "unknown" {
	const status = (issue.status || "").trim();
	if (!status) return "unknown";
	if (status === "in_progress") return "in_progress";
	if (status === "deferred") return "deferred";
	if (status === "open") return "open";
	if (status === "done" || status === "completed") return "done";
	if (status === "closed") return "closed";
	return "unknown";
}

function statusGlyph(issue: BdIssue): string {
	switch (statusKind(issue)) {
		case "done":
			return "✔";
		case "closed":
			return "■";
		case "in_progress":
			return "◐";
		case "deferred":
			return "◇";
		case "open":
			return "□";
		default:
			return "·";
	}
}

function statusGlyphThemed(issue: BdIssue, theme: Theme): string {
	const glyph = statusGlyph(issue);
	switch (statusKind(issue)) {
		case "done":
			return theme.fg("success", glyph);
		case "closed":
			return theme.fg("muted", glyph);
		case "in_progress":
			return theme.fg("accent", glyph);
		case "deferred":
			return theme.fg("muted", glyph);
		case "open":
			return theme.fg("dim", glyph);
		default:
			return theme.fg("dim", glyph);
	}
}

function renderIssueInline(issue: BdIssue, theme: Theme): string {
	const mark = statusGlyphThemed(issue, theme);
	const id = (issue.id || "(no-id)").padEnd(12);
	const prioNum = issue.priority;
	const prioStr = prioNum !== undefined && prioNum !== null ? `P${prioNum}` : "P?";
	const prio = `[${prioStr}]`.padEnd(6);
	const type = `[${issue.issue_type || "?"}]`.padEnd(10);
	const status = `(${issue.status || "???"})`.padEnd(12);
	const title = issue.title || "(no title)";
	const depType = issue.dependency_type ? ` ${theme.fg("dim", `via ${issue.dependency_type}`)}` : "";

	return `${mark}  ${theme.fg("accent", id)}  ${theme.fg("muted", prio)}  ${theme.fg("muted", type)}  ${theme.fg("dim", status)}  ${theme.fg("toolOutput", title)}${depType}`;
}

function renderIssueInlinePlain(issue: BdIssue): string {
	const mark = statusGlyph(issue);
	const id = (issue.id || "(no-id)").padEnd(12);
	const prioNum = issue.priority;
	const prioStr = prioNum !== undefined && prioNum !== null ? `P${prioNum}` : "P?";
	const prio = `[${prioStr}]`.padEnd(6);
	const type = `[${issue.issue_type || "?"}]`.padEnd(10);
	const status = `(${issue.status || "???"})`.padEnd(12);
	const title = issue.title || "(no title)";
	const depType = issue.dependency_type ? ` via ${issue.dependency_type}` : "";

	return `${mark}  ${id}  ${prio}  ${type}  ${status}  ${title}${depType}`;
}

function truncateText(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	return s.slice(0, Math.max(0, maxChars - 20)).trimEnd() + "\n… (truncated)";
}

function renderIssueDetailsPlain(issue: BdIssue): string {
	let out = `${issue.id || "(no-id)"}: ${issue.title || "(no title)"}`;
	const meta: string[] = [];
	if (issue.status) meta.push(`status=${issue.status}`);
	if (issue.priority !== undefined && issue.priority !== null) meta.push(`priority=${issue.priority}`);
	if (issue.issue_type) meta.push(`type=${issue.issue_type}`);
	if (meta.length > 0) out += `\n${meta.join("  ")}`;

	const desc = typeof issue.description === "string" ? issue.description.trim() : "";
	if (desc) out += `\n\n${desc}`;

	return out.trim();
}

function formatBdDetailsAsText(details: BdToolDetails): string {
	if (!details.isJson) return details.outputText || "(no output)";
	return JSON.stringify(details.json, null, 2);
}

function normalizeIssues(json: unknown): BdIssue[] {
	if (Array.isArray(json)) return json as BdIssue[];
	if (json && typeof json === "object") return [json as BdIssue];
	return [];
}

function renderIssuesBlock(issues: BdIssue[], options: { expanded: boolean }, theme: Theme): Text {
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

function renderTreeBlock(nodes: BdTreeNode[], options: { expanded: boolean }, theme: Theme): Text {
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

function renderFallback(kind: string, text: string, theme: Theme): Text {
	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);
	const title = kind.replace("_", " ");
	out += `\n${theme.fg("toolTitle", theme.bold(`bd ${title}`))}`;
	out += `\n${theme.fg("warning", "No renderer for this command yet")}`;
	out += `\n\n${theme.fg("dim", text)}`;
	return new Text(out, 0, 0);
}

type BdComment = {
	id?: number | string;
	issue_id?: string;
	author?: string;
	text?: string;
	created_at?: string;
};

function renderCommentsBlock(json: unknown, theme: Theme): Text {
	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);

	if (!json || (Array.isArray(json) && json.length === 0)) {
		out += `\n${theme.fg("muted", "No comments found")}`;
		return new Text(out, 0, 0);
	}

	const comments = (Array.isArray(json) ? json : [json]) as BdComment[];
	for (const comment of comments) {
		const date = comment.created_at ? comment.created_at.split("T")[0] : "unknown date";
		const author = comment.author || "unknown";
		out += `\n💬 ${theme.fg("toolOutput", "Comment")} by ${theme.fg("accent", author)} on ${theme.fg("dim", date!)}`;
		out += `\n   ${comment.text || "(empty)"}\n`;
	}

	return new Text(out.trim(), 0, 0);
}

function renderDeleteBlock(json: unknown, theme: Theme): Text {
	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);

	if (!json) {
		out += `\n${theme.fg("warning", "No deletion info returned")}`;
		return new Text(out, 0, 0);
	}

	const items = (Array.isArray(json) ? json : [json]) as Array<{
		deleted?: string;
		dependencies_removed?: number;
		references_updated?: number;
	}>;

	for (const item of items) {
		if (item.deleted) {
			out += `\n${theme.fg("success", "✔ Deleted issue:")} ${theme.fg("accent", item.deleted)}`;
			if (item.dependencies_removed) out += `\n  - Removed ${item.dependencies_removed} dependencies`;
			if (item.references_updated) out += `\n  - Updated ${item.references_updated} references`;
		}
	}

	return new Text(out, 0, 0);
}

function renderDepBlock(json: unknown, theme: Theme): Text {
	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);

	if (Array.isArray(json) && json.length === 0) {
		out += `\n${theme.fg("success", "✔ No cycles detected")}`;
		return new Text(out, 0, 0);
	}

	const deps = (Array.isArray(json) ? json : [json]) as Array<{ status: string; type?: string; issue_id: string; depends_on_id: string }>;
	for (const dep of deps) {
		const status = dep.status === "added" ? theme.fg("success", "✔ Added") : theme.fg("warning", "✘ Removed");
		const type = dep.type ? ` (${dep.type})` : "";
		out += `\n${status} dependency: ${theme.fg("accent", dep.issue_id)} ➔ ${theme.fg("accent", dep.depends_on_id)}${type}`;
	}

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
	if (first === "reopen") return "reopen";
	if (first === "delete") return "delete";
	if (first === "search") return "search";
	if (first === "stale") return "stale";
	if (first === "defer") return "defer";
	if (first === "undefer") return "undefer";
	if (first === "pin") return "pin";
	if (first === "unpin") return "unpin";
	if (first === "status") return "status";
	if (first === "comment") return "comment";
	if (first === "comments") return "comments";
	if (first === "dep") {
		if (nonFlags[1] === "list") return "dep_list";
		if (nonFlags[1] === "tree") return "dep_tree";
		if (nonFlags[1] === "add") return "dep_add";
		if (nonFlags[1] === "remove") return "dep_remove";
		if (nonFlags[1] === "cycles") return "dep_cycles";
	}
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
	const jsonCapable: RenderKind[] = [
		"ready",
		"list",
		"blocked",
		"show",
		"dep_tree",
		"dep_list",
		"dep_add",
		"dep_remove",
		"dep_cycles",
		"create",
		"update",
		"close",
		"reopen",
		"delete",
		"search",
		"stale",
		"defer",
		"undefer",
		"pin",
		"unpin",
		"status",
		"comment",
		"comments",
	];

	if (jsonCapable.includes(kind)) {
		return [...args, "--json"];
	}

	return args;
}

function withQuietFlag(args: string[], kind: RenderKind): string[] {
	// Quiet is useful to keep JSON clean, but should not hide output for setup
	// commands like init/onboard/sync/prime.
	if (args.includes("-q") || args.includes("--quiet")) return args;
	if (args.includes("--json")) return ["-q", ...args];

	const quietCapable: RenderKind[] = [
		"ready",
		"list",
		"blocked",
		"show",
		"dep_tree",
		"dep_list",
		"dep_add",
		"dep_remove",
		"dep_cycles",
		"create",
		"update",
		"close",
		"reopen",
		"delete",
		"search",
		"stale",
		"defer",
		"undefer",
		"pin",
		"unpin",
		"status",
		"comment",
		"comments",
	];

	if (quietCapable.includes(kind)) {
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

async function runBd(pi: ExtensionAPI, command: string, signal?: AbortSignal, cwd?: string): Promise<BdToolDetails> {
	const { args, kind } = buildArgs(command);
	const res = await pi.exec("bd", args, {
		...(signal ? { signal } : {}),
		timeout: 60_000,
		...(cwd ? { cwd } : {}),
	});

	const stdout = res.stdout || "";
	const stderr = res.stderr || "";
	const outputText = [stdout, stderr].filter(Boolean).join("").trim();

	// Only consider stdout JSON, and only if stdout is non-empty.
	let isJson = false;
	let parsedJson: unknown | undefined;

	const tryParse = (s: string) => {
		try {
			parsedJson = JSON.parse(s);
			isJson = true;
			return true;
		} catch {
			return false;
		}
	};

	if (stdout.trim().length > 0) {
		if (!tryParse(stdout.trim())) {
			// Try to find a JSON block in the output
			const startBrace = stdout.indexOf("{");
			const startBracket = stdout.indexOf("[");
			const start =
				startBrace !== -1 && startBracket !== -1
					? Math.min(startBrace, startBracket)
					: startBrace !== -1
						? startBrace
						: startBracket;

			if (start !== -1) {
				const endBrace = stdout.lastIndexOf("}");
				const endBracket = stdout.lastIndexOf("]");
				const end = Math.max(endBrace, endBracket);

				if (end !== -1 && end > start) {
					tryParse(stdout.slice(start, end + 1));
				}
			}
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

function renderStatusBlock(json: unknown, theme: Theme): Text {
	const summary = (json as { summary?: Record<string, unknown> }).summary || {};
	const separator = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);
	out += `\n${theme.fg("toolTitle", theme.bold("Beads Status"))}`;

	const row = (label: string, value: unknown) => `\n  ${label.padEnd(20)}: ${theme.fg("toolOutput", String(value))}`;

	out += row("Total Issues", summary["total_issues"]);
	out += row("Open", summary["open_issues"]);
	out += row("In Progress", summary["in_progress_issues"]);
	out += row("Closed", summary["closed_issues"]);
	out += row("Blocked", summary["blocked_issues"]);
	out += row("Ready", summary["ready_issues"]);
	out += row("Deferred", summary["deferred_issues"]);
	out += row("Pinned", summary["pinned_issues"]);

	if (summary["average_lead_time_hours"]) {
		const hours = Number(summary["average_lead_time_hours"]).toFixed(1);
		out += row("Avg Lead Time", `${hours}h`);
	}

	return new Text(out, 0, 0);
}

function renderBd(details: BdToolDetails, options: { expanded: boolean }, theme: Theme) {
	if (!details.isJson) {
		const text = details.outputText || "(no output)";

		if (
			details.kind === "help" ||
			details.kind === "init" ||
			details.kind === "onboard" ||
			details.kind === "sync" ||
			details.kind === "prime" ||
			details.kind === "dep_add" ||
			details.kind === "dep_remove" ||
			details.kind === "dep_cycles" ||
			details.kind === "delete" ||
			details.kind === "comment" ||
			details.kind === "comments"
		) {
			const mdTheme = getMarkdownTheme();
			return new Markdown(text, 0, 0, mdTheme);
		}

		return renderFallback(details.kind, text, theme);
	}

	const json = details.json;
	if (details.kind === "status") return renderStatusBlock(json, theme);
	if (details.kind === "comment" || details.kind === "comments") return renderCommentsBlock(json, theme);
	if (details.kind === "dep_add" || details.kind === "dep_remove" || details.kind === "dep_cycles") return renderDepBlock(json, theme);
	if (details.kind === "delete") return renderDeleteBlock(json, theme);

	const issues = normalizeIssues(json);
	if (details.kind === "ready") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "list") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "dep_list") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "blocked") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "search") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "stale") return renderIssuesBlock(issues, options, theme);
	if (details.kind === "show") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "dep_tree") return renderTreeBlock(issues as BdTreeNode[], options, theme);
	if (details.kind === "create") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "update") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "close") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "reopen") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "defer") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "undefer") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "pin") return renderIssuesBlock(issues, { expanded: true }, theme);
	if (details.kind === "unpin") return renderIssuesBlock(issues, { expanded: true }, theme);

	return renderFallback("unknown", JSON.stringify(json, null, 2), theme);
}

export default function initBeads(pi: ExtensionAPI, _state: TauState) {
	// Keep /bd command outputs out of LLM context.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m) => !(m?.role === "custom" && m?.customType === BD_MESSAGE_TYPE));
		return { messages: filtered };
	});

	pi.on("before_agent_start", async (event) => {
		const hint =
			"Beads integration: Prefer the `bd` tool over `bash` for Beads operations. The tool is a wrapper around the `bd` CLI and exists mainly for nice user rendering.";
		return { systemPrompt: `${hint}\n\n${event.systemPrompt}` };
	});

	const bdInitFlow = async (ctx: ExtensionContext): Promise<void> => {
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
				{ value: "dep list ", label: "dep list", description: "List dependencies" },
				{ value: "dep tree ", label: "dep tree", description: "Dependency tree" },
				{ value: "search ", label: "search", description: "Search issues" },
				{ value: "reopen ", label: "reopen", description: "Reopen issues" },
				{ value: "stale", label: "stale", description: "Show stale issues" },
				{ value: "defer ", label: "defer", description: "Defer issues" },
				{ value: "undefer ", label: "undefer", description: "Undefer issues" },
				{ value: "pin ", label: "pin", description: "Pin issues" },
				{ value: "unpin ", label: "unpin", description: "Unpin issues" },
				{ value: "init", label: "init", description: "Initialize repository" },
				{ value: "onboard", label: "onboard", description: "Onboarding instructions" },
				{ value: "sync", label: "sync", description: "Sync issues with git" },
				{ value: "prime", label: "prime", description: "Prime local cache" },
				{ value: "status", label: "status", description: "Show database statistics" },
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
		return renderBd(details, options, theme as Theme);
	});

	pi.registerTool({
		name: "bd",
		label: "bd",
		description:
			"Wrapper around the `bd` (Beads) CLI created mainly to render output nicely for the user. Provide `command` and omit the leading `bd` (it will be stripped if present).\n\nCommon examples:\n- List all issues: `list`\n- List ready work (unblocked): `ready`\n- List blocked work: `blocked`\n- Show issue: `show tau-xxxx`\n- Create task: `create \"Title\" --type task --priority 2 --description \"...\"`\n- Create epic: `create \"Epic title\" --type epic --priority 1 --description \"...\"`\n- Update status: `update tau-xxxx --status in_progress`\n- Close issue: `close tau-xxxx --reason \"Done\"`\n- Init: `init`\n- Onboard: `onboard`\n- Sync: `sync`\n- Help: `help` (forwarded to `bd --help`) or `help show`",
		parameters: bdParams,

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const details = await runBd(pi, params.command, signal, params.cwd);

			if (details.code && details.code !== 0) {
				const errText = details.outputText || `bd exited with code ${details.code}`;
				return { content: [{ type: "text", text: errText }], details };
			}

			if (details.isJson) {
				const text = formatBdDetailsAsText(details);
				return {
					content: [{ type: "text", text }],
					details,
				};
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
			if (args?.cwd) {
				out += `\n${theme.fg("muted", `cwd: ${args.cwd}`)}`;
			}
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
			return renderBd(details, options, theme as Theme);
		},
	});
}
