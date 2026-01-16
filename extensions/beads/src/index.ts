import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
	| "help"
	| "unknown";

type BeadsToolDetails = {
	argv: string[];
	kind: RenderKind;
	isJson: boolean;
	json?: unknown;
	stdout?: string;
	stderr?: string;
};

const beadsParams = Type.Object({
	command: Type.String({
		description:
			"Beads command to run. You may omit the leading `bd`. Examples: `ready`, `list`, `show tau-xyz`, `dep tree tau-xyz --direction up`.",
	}),
});

function statusMark(status: string | undefined): "done" | "todo" {
	if (status === "closed" || status === "done") return "done";
	return "todo";
}

function renderIssueInline(issue: BdIssue, theme: any): string {
	const check = statusMark(issue.status) === "done" ? theme.fg("success", "✔") : theme.fg("dim", "□");
	const id = issue.id ? theme.fg("accent", issue.id) : theme.fg("dim", "(no-id)");
	const title = issue.title ? theme.fg("toolOutput", issue.title) : theme.fg("dim", "(no title)");

	const statusSuffix = issue.status ? ` ${theme.fg("dim", `(${issue.status})`)}` : "";
	const prio = issue.priority !== undefined ? theme.fg("muted", `P${issue.priority}`) : theme.fg("dim", "P?");
	const type = issue.issue_type ? theme.fg("muted", issue.issue_type) : theme.fg("dim", "?");

	return `${check} ${id} ${prio} ${type}${statusSuffix} ${title}`;
}

function renderHeader(title: string, theme: any): string {
	return theme.fg("toolTitle", `• ${theme.bold(title)}`);
}

function normalizeIssues(json: unknown): BdIssue[] {
	if (Array.isArray(json)) return json as BdIssue[];
	if (json && typeof json === "object") return [json as BdIssue];
	return [];
}

function renderIssuesBlock(title: string, issues: BdIssue[], options: { expanded: boolean }, theme: any): Text {
	const all = issues || [];
	const shown = options.expanded ? all : all.slice(0, 10);

	let out = renderHeader(title, theme);
	for (let i = 0; i < shown.length; i++) {
		const issue = shown[i]!;
		const prefix = i === 0 ? "  └ " : "    ";
		out += `\n${prefix}${renderIssueInline(issue, theme)}`;
	}
	if (!options.expanded && all.length > shown.length) {
		out += `\n    ${theme.fg("dim", `… ${all.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderTreeBlock(nodes: BdTreeNode[], options: { expanded: boolean }, theme: any): Text {
	const all = nodes || [];
	const shown = options.expanded ? all : all.slice(0, 50);

	let out = renderHeader("Dependency tree", theme);
	for (const node of shown) {
		const depth = typeof node.depth === "number" ? node.depth : 0;
		const prefix = "  ".repeat(Math.max(0, depth) + 1) + "└ ";
		out += `\n${prefix}${renderIssueInline(node, theme)}`;
	}
	if (!options.expanded && all.length > shown.length) {
		out += `\n    ${theme.fg("dim", `… ${all.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderFallback(kind: string, text: string, theme: any): Text {
	let out = renderHeader(`beads ${kind}`, theme);
	out += `\n  └ ${theme.fg("warning", "No renderer for this command yet")}`;
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
			if (ch === "'") {
				mode = "none";
			} else {
				current += ch;
			}
			continue;
		}

		if (mode === "double") {
			if (ch === '"') {
				mode = "none";
			} else {
				current += ch;
			}
			continue;
		}

		// mode === none
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
	if (first === "help") return "help";
	return "unknown";
}

function withQuietFlag(args: string[]): string[] {
	if (args.includes("-q") || args.includes("--quiet")) return args;
	return ["-q", ...args];
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

function ensureJsonFlag(args: string[]): string[] {
	// We try to ensure JSON for known commands, but never force it for help.
	if (args.includes("--help") || args.includes("-h")) return args;
	if (args.includes("--json")) return args;

	const kind = commandKind(args);
	const likelyJson = kind !== "unknown" && kind !== "help";
	if (!likelyJson) return args;
	return [...args, "--json"];
}

export default function beads(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const hint =
			"Beads integration: Use the `beads` tool as a wrapper for `bd` CLI. Pass `command` without the leading `bd` (it will be stripped if present). This exists primarily for nicer rendering.";
		return { systemPrompt: `${hint}\n\n${event.systemPrompt}` };
	});

	const beadsInitFlow = async (ctx: any): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/beads init requires interactive mode", "error");
			return;
		}

		const instructions =
			"Beads init checklist:\n\n" +
			"1) Verify Beads skill is installed globally and up-to-date:\n" +
			"   - Ensure `~/.pi/agent/skills/beads/SKILL.md` exists\n" +
			"   - Compare to upstream: https://github.com/steveyegge/beads/tree/main/claude-plugin/skills/beads\n\n" +
			"2) If skill is OK, let the agent initialize this repo:\n" +
			"   - Agent runs `bd init` (creates .beads and config)\n" +
			"   - Agent runs `bd onboard` and follows its instructions (may ask you to do manual steps)\n";

		ctx.ui.setEditorText(instructions);

		const ok = await ctx.ui.confirm(
			"Beads Init",
			"Skill checked and up-to-date? Let the agent run bd init + bd onboard now?",
		);
		if (!ok) return;

		// Use the agent (tool calls) to execute the init steps.
		pi.sendUserMessage(
			"Initialize Beads in this repository.\n\n" +
				"Rules:\n" +
				"- Use the `beads` tool (not bash).\n" +
				"- Use `command` and omit the leading `bd`.\n\n" +
				"Steps:\n" +
				"1) Run `init`.\n" +
				"2) Run `onboard` and follow the instructions it prints.\n" +
				"3) If onboard requires manual user steps, summarize them and ask the user to confirm when done.",
		);
	};

	pi.registerCommand("beads", {
		description: "Beads commands: /beads init",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] || "";

			if (!sub || sub === "help") {
				ctx.ui.notify("Usage: /beads init", "info");
				return;
			}

			if (sub === "init") {
				await beadsInitFlow(ctx);
				return;
			}

			ctx.ui.notify("Usage: /beads init", "info");
		},
	});

	// Backwards-compatible alias
	pi.registerCommand("beads-init", {
		description: "Alias for /beads init",
		handler: async (_args, ctx) => {
			await beadsInitFlow(ctx);
		},
	});

	pi.registerTool({
		name: "beads",
		label: "Beads",
		description:
			"Wrapper around the `bd` (Beads) CLI created mainly to render output nicely for the user. Provide `command` and omit the leading `bd` (it will be stripped if present).\n\nCommon examples:\n- List all issues: `list`\n- List ready work (unblocked): `ready`\n- List blocked work: `blocked`\n- Show issue: `show tau-xxxx`\n- Create task: `create \"Title\" --type task --priority 2 --description \"...\"`\n- Create epic: `create \"Epic title\" --type epic --priority 1 --description \"...\"`\n- Update status: `update tau-xxxx --status in_progress`\n- Close issue: `close tau-xxxx --reason \"Done\"`\n- Help: `help` (forwarded to `bd --help`) or `help show`",
		parameters: beadsParams,

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const raw = stripLeadingPrompt(params.command);
			const tokens = shellSplit(raw);
			const withoutBd = stripLeadingBd(tokens);

			let args = helpRewrite(withoutBd);
			args = withQuietFlag(args);
			args = ensureJsonFlag(args);

			const kind = commandKind(args);

			const res = await pi.exec("bd", args, { signal, timeout: 30_000 });

			// If JSON was requested but we got non-JSON output, allow fallback render.
			let parsedJson: unknown | undefined;
			let isJson = false;
			try {
				parsedJson = res.stdout.trim() ? JSON.parse(res.stdout) : null;
				isJson = true;
			} catch {
				parsedJson = undefined;
				isJson = false;
			}

			const details: BeadsToolDetails = {
				argv: ["bd", ...args],
				kind,
				isJson,
				json: parsedJson,
				stdout: res.stdout,
				stderr: res.stderr,
			};

			if (res.code !== 0) {
				const errText = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || `bd exited with code ${res.code}`;
				return {
					content: [{ type: "text", text: errText }],
					details,
				};
			}

			if (isJson) {
				return {
					content: [{ type: "json", json: parsedJson }],
					details,
				};
			}

			// Plain text output
			const out = [res.stdout, res.stderr].filter(Boolean).join("").trim();
			return {
				content: [{ type: "text", text: out || "(no output)" }],
				details,
			};
		},

		renderCall(args, theme) {
			const cmd = typeof args?.command === "string" ? args.command.trim() : "";
			const shown = cmd.startsWith("bd") ? cmd : `bd ${cmd}`;
			return new Text(theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("toolTitle", shown), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as BeadsToolDetails | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "(no beads details)"), 0, 0);
			}

			if (!details.isJson) {
				const text = (details.stdout || details.stderr || "").trim();
				return renderFallback(details.kind, text || "(no output)", theme);
			}

			const json = details.json;
			switch (details.kind) {
				case "ready":
					return renderIssuesBlock("Ready", normalizeIssues(json), options, theme);
				case "list":
					return renderIssuesBlock("List", normalizeIssues(json), options, theme);
				case "blocked":
					return renderIssuesBlock("Blocked", normalizeIssues(json), options, theme);
				case "show":
					return renderIssuesBlock("Show", normalizeIssues(json), { expanded: true }, theme);
				case "dep_tree":
					return renderTreeBlock(normalizeIssues(json) as BdTreeNode[], options, theme);
				case "create":
					return renderIssuesBlock("Created", normalizeIssues(json), { expanded: true }, theme);
				case "update":
					return renderIssuesBlock("Updated", normalizeIssues(json), { expanded: true }, theme);
				case "close":
					return renderIssuesBlock("Closed", normalizeIssues(json), { expanded: true }, theme);
				case "help": {
					const text = (details.stdout || details.stderr || "").trim();
					return new Text(text ? theme.fg("toolOutput", text) : theme.fg("dim", "(no output)"), 0, 0);
				}
				default:
					return renderFallback("unknown", JSON.stringify(json, null, 2), theme);
			}
		},
	});
}
