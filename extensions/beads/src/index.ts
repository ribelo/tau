import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const BEADS_RENDER_TYPE = "beads:render";

type BeadsKind =
	| "ready"
	| "blocked"
	| "list"
	| "show"
	| "create"
	| "update"
	| "close"
	| "dep_tree"
	| "unknown";

type BeadsRenderDetails = {
	command: string;
	kind: BeadsKind;
	json: unknown;
	parseWarning?: string;
};

type BdIssue = {
	id?: string;
	title?: string;
	status?: string;
	priority?: number | string;
	issue_type?: string;
	labels?: string[];
	dependency_count?: number;
	dependent_count?: number;
	blocked_by_count?: number;
	blocked_by?: string[];
	created_at?: string;
	updated_at?: string;
	closed_at?: string;
	close_reason?: string;
	[extra: string]: unknown;
};

type BdTreeNode = BdIssue & {
	depth?: number;
	parent_id?: string;
	truncated?: boolean;
};

function getTextOutput(content: Array<{ type: string; text?: string }>): string {
	return (content || [])
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
}

function looksLikeBdCommand(command: string): boolean {
	// Common patterns:
	// - bd ready --json
	// - bd -q ready --json
	// - BEADS_DB=... bd ready --json
	return /(^|\s)(?:\w+=\S+\s+)*bd\b/.test(command);
}

function hasBeadsDir(cwd: string): boolean {
	let current = cwd;
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(current, ".beads"))) return true;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

function tokenize(command: string): string[] {
	// Minimal tokenization: good enough for bd subcommand classification.
	// We don't need full shell parsing for rendering.
	return command.trim().split(/\s+/).filter(Boolean);
}

function classifyBdCommand(command: string): { kind: BeadsKind } {
	const tokens = tokenize(command);
	const bdIndex = tokens.findIndex((t) => t === "bd" || t.endsWith("/bd"));
	if (bdIndex === -1) return { kind: "unknown" };

	const afterBd = tokens.slice(bdIndex + 1);
	const nonFlags = afterBd.filter((t) => !t.startsWith("-"));
	if (nonFlags.length === 0) return { kind: "unknown" };

	const cmd = nonFlags[0];
	if (cmd === "ready") return { kind: "ready" };
	if (cmd === "blocked") return { kind: "blocked" };
	if (cmd === "list") return { kind: "list" };
	if (cmd === "show") return { kind: "show" };
	if (cmd === "create" || cmd === "new") return { kind: "create" };
	if (cmd === "update") return { kind: "update" };
	if (cmd === "close") return { kind: "close" };
	if (cmd === "dep" && nonFlags[1] === "tree") return { kind: "dep_tree" };
	return { kind: "unknown" };
}

function sliceFirstJsonValue(text: string): string | undefined {
	const start = (() => {
		const obj = text.indexOf("{");
		const arr = text.indexOf("[");
		if (obj === -1) return arr;
		if (arr === -1) return obj;
		return Math.min(obj, arr);
	})();
	if (start === -1) return undefined;

	let i = start;
	let inString = false;
	let escaped = false;
	const stack: string[] = [];

	for (; i < text.length; i++) {
		const ch = text[i]!;

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{" || ch === "[") {
			stack.push(ch);
			continue;
		}
		if (ch === "}" || ch === "]") {
			const open = stack.pop();
			if (!open) return undefined;
			if (open === "{" && ch !== "}") return undefined;
			if (open === "[" && ch !== "]") return undefined;
			if (stack.length === 0) {
				return text.slice(start, i + 1);
			}
		}
	}

	return undefined;
}

function tryParseBdJson(output: string, fullOutputPath?: string): { json?: unknown; warning?: string } {
	const parseFromFile = (): { json?: unknown; warning?: string } => {
		if (!fullOutputPath) return { warning: "No full output path available" };
		try {
			const st = statSync(fullOutputPath);
			if (st.size > 2 * 1024 * 1024) {
				return { warning: `Output truncated and full output is too large to parse (${st.size} bytes)` };
			}
			const full = readFileSync(fullOutputPath, "utf-8");
			const fullCandidate = sliceFirstJsonValue(full);
			if (!fullCandidate) return { warning: "Output truncated and no JSON found in full output" };
			return { json: JSON.parse(fullCandidate) };
		} catch (err) {
			return { warning: `Failed to parse JSON from full output file: ${(err as Error).message}` };
		}
	};

	const candidate = sliceFirstJsonValue(output);
	if (candidate) {
		try {
			return { json: JSON.parse(candidate) };
		} catch (err) {
			if (fullOutputPath) {
				const fallback = parseFromFile();
				if (fallback.json) return fallback;
				return {
					warning:
						`Failed to parse JSON from bash output: ${(err as Error).message}. ` + (fallback.warning || ""),
				};
			}
			return { warning: `Failed to parse JSON from bash output: ${(err as Error).message}` };
		}
	}

	if (fullOutputPath) {
		return parseFromFile();
	}

	return { warning: "No JSON found in bash output" };
}

function issueSummary(issue: BdIssue): string {
	const id = issue.id || "";
	const title = issue.title || "";
	return `${id} ${title}`.trim();
}

function formatIssueLine(issue: BdIssue, theme: any): string {
	const id = issue.id ? theme.fg("accent", issue.id) : theme.fg("dim", "(no-id)");
	const prio = issue.priority !== undefined ? theme.fg("muted", `P${issue.priority}`) : theme.fg("dim", "P?");
	const type = issue.issue_type ? theme.fg("muted", issue.issue_type) : theme.fg("dim", "?");

	const statusRaw = issue.status || "";
	const status = (() => {
		if (statusRaw === "closed") return theme.fg("dim", statusRaw);
		if (statusRaw === "in_progress") return theme.fg("warning", statusRaw);
		if (statusRaw === "open") return theme.fg("success", statusRaw);
		return theme.fg("muted", statusRaw || "?");
	})();

	const title = issue.title ? theme.fg("toolOutput", issue.title) : theme.fg("dim", "(no title)");
	return `${id} ${prio} ${type} ${status} ${title}`;
}

function renderIssueList(
	kindLabel: string,
	issues: BdIssue[],
	options: { expanded: boolean },
	theme: any,
): Text {
	const list = issues || [];
	if (list.length === 0) {
		return new Text(theme.fg("dim", `No issues (${kindLabel})`), 0, 0);
	}

	const show = options.expanded ? list : list.slice(0, 12);
	let out = theme.fg("toolTitle", theme.bold(`${kindLabel}: `)) + theme.fg("muted", `${list.length}`);

	for (const issue of show) {
		out += `\n${formatIssueLine(issue, theme)}`;
	}
	if (!options.expanded && list.length > show.length) {
		out += `\n${theme.fg("dim", `... ${list.length - show.length} more (expand to view)`)}`;
	}

	return new Text(out, 0, 0);
}

function renderDepTree(nodes: BdTreeNode[], options: { expanded: boolean }, theme: any): Text {
	const list = nodes || [];
	if (list.length === 0) return new Text(theme.fg("dim", "No dependency nodes"), 0, 0);

	const show = options.expanded ? list : list.slice(0, 30);
	let out = theme.fg("toolTitle", theme.bold("Dependency tree"));
	for (const node of show) {
		const depth = typeof node.depth === "number" ? node.depth : 0;
		const indent = "  ".repeat(Math.max(0, depth));
		out += `\n${indent}${formatIssueLine(node, theme)}`;
	}
	if (!options.expanded && list.length > show.length) {
		out += `\n${theme.fg("dim", `... ${list.length - show.length} more nodes (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderShow(issues: BdIssue[], options: { expanded: boolean }, theme: any): Text {
	const issue = issues?.[0];
	if (!issue) return new Text(theme.fg("dim", "No issue"), 0, 0);

	let out = theme.fg("toolTitle", theme.bold(issue.id || "Issue"));
	if (issue.title) out += ` ${theme.fg("toolOutput", issue.title)}`;

	const meta: string[] = [];
	if (issue.issue_type) meta.push(theme.fg("muted", issue.issue_type));
	if (issue.priority !== undefined) meta.push(theme.fg("muted", `P${issue.priority}`));
	if (issue.status) meta.push(theme.fg("muted", issue.status));
	if (issue.labels?.length) meta.push(theme.fg("dim", `labels: ${issue.labels.join(", ")}`));
	if (typeof issue.dependency_count === "number" || typeof issue.dependent_count === "number") {
		meta.push(
			theme.fg(
				"dim",
				`deps: ${issue.dependency_count ?? "?"} • dependents: ${issue.dependent_count ?? "?"}`,
			),
		);
	}
	if (typeof issue.blocked_by_count === "number") {
		meta.push(theme.fg("warning", `blocked by: ${issue.blocked_by_count}`));
	}
	if (issue.close_reason) meta.push(theme.fg("dim", `close_reason: ${issue.close_reason}`));

	if (meta.length > 0) out += `\n${meta.join("\n")}`;

	if (options.expanded) {
		const timestamps: string[] = [];
		if (issue.created_at) timestamps.push(`created: ${issue.created_at}`);
		if (issue.updated_at) timestamps.push(`updated: ${issue.updated_at}`);
		if (issue.closed_at) timestamps.push(`closed: ${issue.closed_at}`);
		if (timestamps.length > 0) out += `\n\n${theme.fg("dim", timestamps.join("\n"))}`;

		if (issue.blocked_by?.length) {
			out += `\n\n${theme.fg("toolTitle", theme.bold("Blocked by"))}`;
			for (const id of issue.blocked_by) out += `\n${theme.fg("accent", id)}`;
		}
	}

	return new Text(out, 0, 0);
}

async function runBd(pi: ExtensionAPI, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
	const res = await pi.exec("bd", ["-q", ...args], { timeout: timeoutMs });
	if (res.code !== 0) {
		const msg = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
		throw new Error(msg || `bd exited with code ${res.code}`);
	}
	return { stdout: res.stdout || "", stderr: res.stderr || "" };
}

async function showBeadsMessage(pi: ExtensionAPI, command: string, kind: BeadsKind, json: unknown): Promise<void> {
	pi.sendMessage(
		{
			customType: BEADS_RENDER_TYPE,
			content: `beads ${kind}`,
			display: true,
			details: { command, kind, json } satisfies BeadsRenderDetails,
		},
		{ triggerTurn: false },
	);
}

async function beadsReadyInteractive(pi: ExtensionAPI, ctx: any, options?: { claim?: boolean }): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/beads-ready requires interactive mode", "error");
		return;
	}

	const claim = Boolean(options?.claim);

	try {
		const { stdout } = await runBd(pi, ["ready", "--json"]);

		let issues: BdIssue[];
		try {
			issues = (JSON.parse(stdout) as BdIssue[]) || [];
		} catch (err) {
			ctx.ui.notify(`Failed to parse bd ready JSON: ${(err as Error).message}`, "error");
			return;
		}

		if (issues.length === 0) {
			ctx.ui.notify("No ready issues", "info");
			return;
		}

		const items: SelectItem[] = issues.map((i) => ({
			value: i.id || "",
			label: issueSummary(i),
			description: `P${i.priority ?? "?"} ${i.issue_type ?? "?"} ${i.status ?? "?"}`,
		}));

		const selected = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: any) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Beads Ready")), 1, 0));

			const list = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;

		if (claim) {
			await runBd(pi, ["update", selected, "--status", "in_progress", "--json"]);
			ctx.ui.setStatus("beads", `Working on ${selected}`);
		}

		const { stdout: showOut } = await runBd(pi, ["show", selected, "--json"]);

		let showJson: unknown;
		try {
			showJson = JSON.parse(showOut);
		} catch (err) {
			ctx.ui.notify(`Failed to parse bd show JSON: ${(err as Error).message}`, "error");
			return;
		}

		await showBeadsMessage(pi, `bd show ${selected} --json`, "show", showJson);
	} catch (err) {
		ctx.ui.notify((err as Error).message, "error");
	}
}

export default function beads(pi: ExtensionAPI) {
	// Keep beads UI-only messages out of the LLM context.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m: any) => !(m?.role === "custom" && m?.customType === BEADS_RENDER_TYPE));
		return { messages: filtered };
	});

	// Encourage machine-readable bd output when agent uses bash.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!hasBeadsDir(ctx.cwd)) return;
		const hint =
			"When invoking Beads via bash, prefer machine-readable output: use `bd -q ... --json` so extensions can render results cleanly.";
		return { systemPrompt: `${hint}\n\n${event.systemPrompt}` };
	});

	// Decorate bash results for `bd ... --json` commands.
	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!hasBeadsDir(ctx.cwd)) return;
		if (event.toolName !== "bash") return;

		const command = (event.input as any)?.command;
		if (typeof command !== "string") return;
		if (!looksLikeBdCommand(command)) return;
		if (!/(^|\s)--json(\s|$)/.test(command)) return;

		const kind = classifyBdCommand(command).kind;

		const details: any = (event as any).details;
		const fullOutputPath: string | undefined = details?.fullOutputPath;
		const truncation = details?.truncation;

		const output = getTextOutput(event.content as any);
		const parsed = tryParseBdJson(output, truncation?.truncated ? fullOutputPath : undefined);
		if (!parsed.json) return;

		pi.sendMessage(
			{
				customType: BEADS_RENDER_TYPE,
				content: `beads ${kind}`,
				display: true,
				details: {
					command,
					kind,
					json: parsed.json,
					parseWarning: parsed.warning,
				} satisfies BeadsRenderDetails,
			},
			{ triggerTurn: false },
		);
	});

	// Decorate user-executed bash commands (the `!` / `!!` flow).
	// Without this, `!bd ... --json` won't emit tool_result events.
	pi.on("user_bash", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!hasBeadsDir(ctx.cwd)) return;
		if (!looksLikeBdCommand(event.command)) return;
		if (!/(^|\s)--json(\s|$)/.test(event.command)) return;

		const result = await executeBash(event.command);

		const kind = classifyBdCommand(event.command).kind;
		const parsed = tryParseBdJson(result.output, result.truncated ? result.fullOutputPath : undefined);
		if (parsed.json) {
			pi.sendMessage(
				{
					customType: BEADS_RENDER_TYPE,
					content: `beads ${kind}`,
					display: true,
					details: {
						command: event.command,
						kind,
						json: parsed.json,
						parseWarning: parsed.warning,
					} satisfies BeadsRenderDetails,
				},
				{ triggerTurn: false },
			);
		}

		return { result };
	});

	pi.registerMessageRenderer<BeadsRenderDetails>(BEADS_RENDER_TYPE, (message, options, theme) => {
		const details = message.details;
		if (!details) return new Text(theme.fg("dim", "(no beads details)"), 0, 0);

		const header = theme.fg("toolTitle", theme.bold("beads ")) + theme.fg("muted", details.kind);
		const warning = details.parseWarning ? `\n${theme.fg("warning", details.parseWarning)}` : "";

		try {
			if (details.kind === "dep_tree" && Array.isArray(details.json)) {
				return renderDepTree(details.json as BdTreeNode[], options, theme);
			}
			if (details.kind === "ready" && Array.isArray(details.json)) {
				return renderIssueList("Ready", details.json as BdIssue[], options, theme);
			}
			if (details.kind === "blocked" && Array.isArray(details.json)) {
				return renderIssueList("Blocked", details.json as BdIssue[], options, theme);
			}
			if (details.kind === "list" && Array.isArray(details.json)) {
				return renderIssueList("List", details.json as BdIssue[], options, theme);
			}
			if (details.kind === "show" && Array.isArray(details.json)) {
				return renderShow(details.json as BdIssue[], options, theme);
			}
			if ((details.kind === "create" || details.kind === "update" || details.kind === "close") && details.json) {
				const issue = Array.isArray(details.json) ? (details.json[0] as BdIssue | undefined) : (details.json as BdIssue);
				if (issue?.id) {
					return new Text(
						header +
							"\n" +
							formatIssueLine(issue, theme) +
							(issue.title ? `\n${theme.fg("dim", issue.title)}` : "") +
							warning,
						0,
						0,
					);
				}
			}

			// Fallback: show header + compact JSON.
			const jsonText = theme.fg("dim", JSON.stringify(details.json, null, 2));
			return new Text(`${header}${warning}\n\n${jsonText}`, 0, 0);
		} catch (err) {
			return new Text(
				`${header}\n${theme.fg("error", `Render error: ${(err as Error).message}`)}`,
				0,
				0,
			);
		}
	});

	// User commands
	pi.registerCommand("beads-ready", {
		description: "Pick from bd ready (renders nicely)",
		handler: async (args, ctx) => {
			const claim = (args || "").includes("claim");
			await beadsReadyInteractive(pi, ctx, { claim });
		},
	});

	pi.registerCommand("beads-show", {
		description: "Show a beads issue (renders nicely): /beads-show <id>",
		handler: async (args, ctx) => {
			const id = (args || "").trim();
			if (!id) {
				ctx.ui.notify("Usage: /beads-show <id>", "info");
				return;
			}

			try {
				const { stdout } = await runBd(pi, ["show", id, "--json"]);
				await showBeadsMessage(pi, `bd show ${id} --json`, "show", JSON.parse(stdout));
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});

	pi.registerCommand("beads", {
		description: "Beads helpers: /beads ready [claim] | /beads show <id>",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] || "";

			if (!sub) {
				ctx.ui.notify("Usage: /beads ready [claim] | /beads show <id>", "info");
				return;
			}

			if (sub === "ready") {
				const claim = parts.includes("claim");
				await beadsReadyInteractive(pi, ctx, { claim });
				return;
			}

			if (sub === "show") {
				const id = parts[1] || "";
				if (!id) {
					ctx.ui.notify("Usage: /beads show <id>", "info");
					return;
				}
				try {
					const { stdout } = await runBd(pi, ["show", id, "--json"]);
					await showBeadsMessage(pi, `bd show ${id} --json`, "show", JSON.parse(stdout));
				} catch (err) {
					ctx.ui.notify((err as Error).message, "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /beads ready [claim] | /beads show <id>", "info");
		},
	});
}
