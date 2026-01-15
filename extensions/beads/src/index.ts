import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

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

type BeadsAction =
	| "ready"
	| "list"
	| "blocked"
	| "show"
	| "dep_tree"
	| "create"
	| "update"
	| "close";

type BeadsToolDetails = {
	action: BeadsAction;
	command: string[];
	result: unknown;
};

function toStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x) => typeof x === "string") as string[];
}

function safeJsonParse(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	return JSON.parse(trimmed);
}

function normalizeIssues(json: unknown): BdIssue[] {
	if (Array.isArray(json)) return json as BdIssue[];
	if (json && typeof json === "object") return [json as BdIssue];
	return [];
}

function statusMark(status: string | undefined): "done" | "todo" {
	if (status === "closed" || status === "done") return "done";
	return "todo";
}

function renderIssueLine(issue: BdIssue, theme: any): string {
	const mark = statusMark(issue.status);
	const check = mark === "done" ? theme.fg("success", "✔") : theme.fg("dim", "□");
	const id = issue.id ? theme.fg("accent", issue.id) : theme.fg("dim", "(no-id)");
	const title = issue.title ? theme.fg("toolOutput", issue.title) : theme.fg("dim", "(no title)");

	const status = issue.status ? theme.fg("muted", issue.status) : "";
	const statusSuffix = status ? ` ${theme.fg("dim", `(${issue.status})`)}` : "";

	const prio = issue.priority !== undefined ? theme.fg("muted", `P${issue.priority}`) : theme.fg("dim", "P?");
	const type = issue.issue_type ? theme.fg("muted", issue.issue_type) : theme.fg("dim", "?");

	// Example style:
	//   └ ✔ tau-123 P2 task (closed) Title
	return `  └ ${check} ${id} ${prio} ${type}${statusSuffix} ${title}`;
}

function renderHeader(title: string, theme: any): string {
	// Example style:
	// • Updated Plan
	return theme.fg("toolTitle", `• ${theme.bold(title)}`);
}

function renderIssuesBlock(title: string, issues: BdIssue[], options: { expanded: boolean }, theme: any): Text {
	const all = issues || [];
	const shown = options.expanded ? all : all.slice(0, 10);

	let out = renderHeader(title, theme);
	for (const issue of shown) {
		out += `\n${renderIssueLine(issue, theme)}`;
	}
	if (!options.expanded && all.length > shown.length) {
		out += `\n  ${theme.fg("dim", `└ … ${all.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderTreeBlock(nodes: BdTreeNode[], options: { expanded: boolean }, theme: any): Text {
	const all = nodes || [];
	const shown = options.expanded ? all : all.slice(0, 50);

	let out = renderHeader("Dependency tree", theme);
	for (const node of shown) {
		const depth = typeof node.depth === "number" ? node.depth : 0;
		const indent = "  ".repeat(Math.max(0, depth));
		// Use the same style but add depth indentation before the connector.
		const line = renderIssueLine(node, theme).replace(/^  └ /, `${indent}└ `);
		out += `\n${line}`;
	}
	if (!options.expanded && all.length > shown.length) {
		out += `\n  ${theme.fg("dim", `└ … ${all.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

export default function beads(pi: ExtensionAPI) {
	// Steer the agent to use the beads tool (not bash) when possible.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.cwd) return;
		const hint =
			"Beads integration: Prefer the `beads` tool over `bash` for bd operations. Use `beads` with an `action` (ready/show/dep_tree/create/update/close).";
		return { systemPrompt: `${hint}\n\n${event.systemPrompt}` };
	});

	pi.registerTool({
		name: "beads",
		label: "Beads",
		description:
			"Beads issue tracker helper with nice rendering. Uses bd CLI under the hood (runs `bd -q ... --json`). Actions: ready, list, blocked, show, dep_tree, create, update, close.",
		parameters: Type.Object({
			action: StringEnum(["ready", "list", "blocked", "show", "dep_tree", "create", "update", "close"] as const),
			id: Type.Optional(Type.String({ description: "Issue id (for show/update/close/dep_tree)" })),
			title: Type.Optional(Type.String({ description: "Issue title (for create)" })),
			description: Type.Optional(Type.String({ description: "Issue description (for create)" })),
			type: Type.Optional(
				StringEnum(["bug", "feature", "task", "epic", "chore"] as const, {
					description: "Issue type (for create)",
				}),
			),
			priority: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 4 }), Type.String()])),
			status: Type.Optional(
				StringEnum(["open", "in_progress", "closed"] as const, {
					description: "Status (for update)",
				}),
			),
			labels: Type.Optional(Type.Array(Type.String())),
			deps: Type.Optional(Type.Array(Type.String({ description: "Dependency spec like discovered-from:tau-xyz" }))),
			parent: Type.Optional(Type.String({ description: "Parent issue id (for create)" })),
			maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "dep_tree depth" })),
			direction: Type.Optional(
				StringEnum(["down", "up", "both"] as const, {
					description: "dep_tree direction",
				}),
			),
			reason: Type.Optional(Type.String({ description: "Close reason (for close)" })),
		}),

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const action = params.action as BeadsAction;

			const args: string[] = ["-q"];
			switch (action) {
				case "ready":
					args.push("ready", "--json");
					break;
				case "list":
					args.push("list", "--json");
					break;
				case "blocked":
					args.push("blocked", "--json");
					break;
				case "show": {
					if (!params.id) throw new Error("beads show requires id");
					args.push("show", String(params.id), "--json");
					break;
				}
				case "dep_tree": {
					if (!params.id) throw new Error("beads dep_tree requires id");
					args.push("dep", "tree", String(params.id));
					args.push("--json");
					args.push("--max-depth", String(params.maxDepth ?? 10));
					if (params.direction) args.push("--direction", String(params.direction));
					break;
				}
				case "create": {
					if (!params.title) throw new Error("beads create requires title");
					args.push("create", String(params.title));
					args.push("--json");
					if (params.description) args.push("--description", String(params.description));
					if (params.type) args.push("--type", String(params.type));
					if (params.priority !== undefined) args.push("--priority", String(params.priority));
					if (params.parent) args.push("--parent", String(params.parent));
					if (Array.isArray(params.labels) && params.labels.length > 0) args.push("--labels", params.labels.join(","));
					const deps = toStringArray(params.deps);
					if (deps.length > 0) args.push("--deps", deps.join(","));
					break;
				}
				case "update": {
					if (!params.id) throw new Error("beads update requires id");
					args.push("update", String(params.id));
					args.push("--json");
					if (params.status) args.push("--status", String(params.status));
					if (params.priority !== undefined) args.push("--priority", String(params.priority));
					if (Array.isArray(params.labels) && params.labels.length > 0) {
						for (const label of params.labels) args.push("--label", String(label));
					}
					break;
				}
				case "close": {
					if (!params.id) throw new Error("beads close requires id");
					args.push("close", String(params.id));
					args.push("--json");
					if (params.reason) args.push("--reason", String(params.reason));
					break;
				}
			}

			const res = await pi.exec("bd", args, { signal, timeout: 30_000 });
			if (res.code !== 0) {
				const msg = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
				throw new Error(msg || `bd exited with code ${res.code}`);
			}

			const parsed = safeJsonParse(res.stdout);

			return {
				content: [{ type: "json", json: parsed }],
				details: {
					action,
					command: ["bd", ...args],
					result: parsed,
				} satisfies BeadsToolDetails,
			};
		},

		renderCall(args, theme) {
			const action = args?.action ? String(args.action) : "";
			const id = args?.id ? ` ${theme.fg("accent", String(args.id))}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("beads ")) + theme.fg("muted", action) + id, 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as BeadsToolDetails | undefined;
			if (!details) {
				const block = result.content?.find((c: any) => c.type === "json");
				return new Text(theme.fg("dim", JSON.stringify((block as any)?.json ?? null, null, 2)), 0, 0);
			}

			const action = details.action;
			const json = details.result;

			if (action === "ready") return renderIssuesBlock("Ready", normalizeIssues(json), options, theme);
			if (action === "list") return renderIssuesBlock("List", normalizeIssues(json), options, theme);
			if (action === "blocked") return renderIssuesBlock("Blocked", normalizeIssues(json), options, theme);
			if (action === "show") return renderIssuesBlock("Show", normalizeIssues(json), { expanded: true }, theme);
			if (action === "dep_tree") return renderTreeBlock(normalizeIssues(json) as BdTreeNode[], options, theme);

			if (action === "create") {
				const issue = normalizeIssues(json)[0];
				if (!issue) return new Text(theme.fg("dim", "(no result)"), 0, 0);
				let out = renderHeader("Created", theme);
				out += `\n${renderIssueLine(issue, theme)}`;
				return new Text(out, 0, 0);
			}

			if (action === "update") {
				const issue = normalizeIssues(json)[0];
				if (!issue) return new Text(theme.fg("dim", "(no result)"), 0, 0);
				let out = renderHeader("Updated", theme);
				out += `\n${renderIssueLine(issue, theme)}`;
				return new Text(out, 0, 0);
			}

			if (action === "close") {
				const issue = normalizeIssues(json)[0];
				if (!issue) return new Text(theme.fg("dim", "(no result)"), 0, 0);
				let out = renderHeader("Closed", theme);
				out += `\n${renderIssueLine(issue, theme)}`;
				if (issue.close_reason) out += `\n  ${theme.fg("dim", `└ reason: ${issue.close_reason}`)}`;
				return new Text(out, 0, 0);
			}

			return new Text(theme.fg("dim", JSON.stringify(json, null, 2)), 0, 0);
		},
	});
}
