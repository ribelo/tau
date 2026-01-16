import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type JsonRecord = Record<string, unknown>;

type ToolRenderOptions = { expanded: boolean; isPartial: boolean };

type ToolResultLike = {
	content?: Array<{ type: "text"; text: string } | { type: "json"; json: any }>;
	details?: unknown;
};

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function truncateLines(s: string, maxLines: number): { text: string; truncated: boolean } {
	const lines = s.split("\n");
	if (lines.length <= maxLines) return { text: s, truncated: false };
	return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function fmtValue(v: unknown): string {
	if (v === undefined) return "(default)";
	if (v === null) return "null";
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) {
		return `[${v
			.slice(0, 4)
			.map((x) => fmtValue(x))
			.join(", ")}${v.length > 4 ? ", …" : ""}]`;
	}
	if (typeof v === "object") return "{…}";
	return String(v);
}

function renderHeader(title: string, theme: any): string {
	return theme.fg("toolTitle", `• ${theme.bold(title)}`);
}

function getJsonBlock(result: ToolResultLike): any | undefined {
	const blocks = result.content || [];
	for (const b of blocks) {
		if (b.type === "json") return b.json;
	}
	return undefined;
}

type ExaSearchResult = {
	id?: string;
	url?: string;
	title?: string;
	score?: number;
	publishedDate?: string;
	author?: string;
	text?: string;
	highlights?: string[];
};

type ExaSearchResponse = {
	requestId?: string;
	results?: ExaSearchResult[];
	resolvedSearchType?: string;
	context?: string;
	[extra: string]: unknown;
};

type ExaContentsResult = {
	id?: string;
	url?: string;
	title?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
	highlightScores?: number[];
	summary?: string;
	subpages?: unknown[];
	extras?: unknown;
};

type ExaContentsResponse = {
	requestId?: string;
	results?: ExaContentsResult[];
	context?: string;
	statuses?: unknown[];
	costDollars?: unknown;
	[extra: string]: unknown;
};

type ExaContextResponse = {
	requestId?: string;
	query?: string;
	response?: string;
	resultsCount?: number;
	costDollars?: unknown;
	searchTime?: number;
	outputTokens?: number;
	[extra: string]: unknown;
};

function getExaConfig(): { baseUrl: string; apiKey: string } {
	const apiKey = (process.env.EXA_API_KEY || "").trim();
	if (!apiKey) {
		throw new Error(
			"EXA_API_KEY is not set. Set it in your environment before using Exa tools (e.g. export EXA_API_KEY=...).",
		);
	}

	const baseUrl = (process.env.EXA_API_BASE_URL || "https://api.exa.ai").replace(/\/+$/, "");
	return { baseUrl, apiKey };
}

async function exaPost<T>(p: string, body: JsonRecord, signal?: AbortSignal): Promise<T> {
	const { baseUrl, apiKey } = getExaConfig();
	const url = `${baseUrl}${p.startsWith("/") ? "" : "/"}${p}`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			// Some environments use Authorization; harmless to include.
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal,
	});

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		json = undefined;
	}

	if (!res.ok) {
		const details = typeof json === "object" && json !== null ? JSON.stringify(json) : String(json);
		throw new Error(`Exa API error (${res.status} ${res.statusText}) for ${p}: ${details}`);
	}

	return json as T;
}

function compactSearchResults(results: ExaSearchResult[] | undefined): Array<{
	url?: string;
	title?: string;
	score?: number;
	publishedDate?: string;
	author?: string;
	id?: string;
	text?: string;
	highlights?: string[];
}> {
	const MAX_TEXT_CHARS = 2000;
	const MAX_HIGHLIGHTS = 5;
	const MAX_HIGHLIGHT_CHARS = 240;

	return (results || []).map((r) => ({
		id: r.id,
		url: r.url,
		title: r.title,
		score: r.score,
		publishedDate: r.publishedDate,
		author: r.author,
		text: typeof r.text === "string" ? truncate(r.text, MAX_TEXT_CHARS) : undefined,
		highlights: Array.isArray(r.highlights)
			? r.highlights
					.slice(0, MAX_HIGHLIGHTS)
					.map((h) => (typeof h === "string" ? truncate(oneLine(h), MAX_HIGHLIGHT_CHARS) : String(h)))
			: undefined,
	}));
}

function compactContentsResults(results: ExaContentsResult[] | undefined): Array<{
	id?: string;
	url?: string;
	title?: string;
	author?: string;
	publishedDate?: string;
	summary?: string;
	text?: string;
	highlights?: string[];
}> {
	const MAX_TEXT_CHARS = 6000;
	const MAX_SUMMARY_CHARS = 2000;
	const MAX_HIGHLIGHTS = 8;
	const MAX_HIGHLIGHT_CHARS = 240;

	return (results || []).map((r) => ({
		id: r.id,
		url: r.url,
		title: r.title,
		author: r.author,
		publishedDate: r.publishedDate,
		summary: typeof r.summary === "string" ? truncate(oneLine(r.summary), MAX_SUMMARY_CHARS) : undefined,
		text: typeof r.text === "string" ? truncate(r.text, MAX_TEXT_CHARS) : undefined,
		highlights: Array.isArray(r.highlights)
			? r.highlights
					.slice(0, MAX_HIGHLIGHTS)
					.map((h) => (typeof h === "string" ? truncate(oneLine(h), MAX_HIGHLIGHT_CHARS) : String(h)))
			: undefined,
	}));
}

function formatSearchResultsAsText(results: ReturnType<typeof compactSearchResults>): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			let out = `[${i + 1}] ${r.title || r.url || "(no title)"}\nURL: ${r.url || "(no url)"}`;
			if (r.publishedDate) out += `\nPublished: ${r.publishedDate}`;
			if (r.author) out += `\nAuthor: ${r.author}`;
			if (r.text) out += `\nSnippet: ${r.text}`;
			if (r.highlights && r.highlights.length > 0) {
				out += `\nHighlights: ${r.highlights.join(" | ")}`;
			}
			return out;
		})
		.join("\n\n");
}

function formatContentsResultsAsText(results: ReturnType<typeof compactContentsResults>): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			let out = `[${i + 1}] ${r.title || r.url || "(no title)"}\nURL: ${r.url || "(no url)"}`;
			if (r.summary) out += `\nSummary: ${r.summary}`;
			if (r.text) out += `\nContent: ${r.text}`;
			if (r.highlights && r.highlights.length > 0) {
				out += `\nHighlights: ${r.highlights.join(" | ")}`;
			}
			return out;
		})
		.join("\n\n");
}

export default function exa(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search_exa",
		label: "exa.web_search",
		description:
			"Search the Exa index (web, papers, GitHub, news, etc.). Use this to find relevant URLs. Best practices: keep numResults small (3-10), use filters (includeDomains/category/date ranges) to narrow results, and only request text when you need snippets.",
		parameters: Type.Object({
			query: Type.String({
				description: "The query string for the search.",
				minLength: 1,
				maxLength: 2000,
			}),

			// Search behavior
			type: Type.Optional(
				Type.String({
					description: "Search type. Options: auto (default), neural, fast, deep.",
				}),
			),
			additionalQueries: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "Additional query variations for deep search (only works with type=deep).",
				}),
			),

			// Filters
			category: Type.Optional(
				Type.String({
					description:
						"Optional category filter. Common options include: company, research paper, news, pdf, github, tweet, personal site, financial report, people.",
				}),
			),
			userLocation: Type.Optional(
				Type.String({
					description: "Two-letter ISO country code of the user (e.g. 'US').",
					minLength: 2,
					maxLength: 2,
				}),
			),

			// Result shaping
			numResults: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 100,
					description: "Number of results to return (default 10; max 100 depending on type).",
				}),
			),
			text: Type.Optional(
				Type.Boolean({
					description:
						"If true, include extracted text snippets in each result (can be large). Best practice: leave off unless needed; use exa.crawl for full text.",
				}),
			),
			context: Type.Optional(
				Type.Boolean({
					description: "If true, also return a combined context string for LLM/RAG usage (can be large).",
				}),
			),

			// Domain + time filters
			includeDomains: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "Only return results from these domains.",
				}),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "Exclude results from these domains.",
				}),
			),
			startCrawlDate: Type.Optional(
				Type.String({
					description:
						"Only include links crawled after this ISO 8601 date-time (e.g. 2023-01-01T00:00:00.000Z).",
				}),
			),
			endCrawlDate: Type.Optional(
				Type.String({
					description: "Only include links crawled before this ISO 8601 date-time.",
				}),
			),
			startPublishedDate: Type.Optional(
				Type.String({
					description:
						"Only include links published after this ISO 8601 date-time (e.g. 2023-01-01T00:00:00.000Z).",
				}),
			),
			endPublishedDate: Type.Optional(
				Type.String({
					description: "Only include links published before this ISO 8601 date-time.",
				}),
			),
			includeText: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Strings that must be present in the result page text (Exa currently supports 1 string of up to ~5 words).",
				}),
			),
			excludeText: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Strings that must NOT be present in the result page text (Exa currently supports 1 string of up to ~5 words).",
				}),
			),

			moderation: Type.Optional(Type.Boolean({ description: "Enable content moderation to filter unsafe content." })),
		}),

		renderCall(args, theme) {
			let out = theme.fg("toolTitle", theme.bold("exa.web_search"));
			const query = typeof (args as any)?.query === "string" ? truncate(oneLine((args as any).query), 140) : "";
			if (query) out += ` ${theme.fg("toolOutput", query)}`;

			const extras: Array<[string, unknown]> = [
				["type", (args as any).type],
				["category", (args as any).category],
				["userLocation", (args as any).userLocation],
				["additionalQueries", (args as any).additionalQueries],
				["numResults", (args as any).numResults],
				["text", (args as any).text],
				["context", (args as any).context],
				["includeDomains", (args as any).includeDomains],
				["excludeDomains", (args as any).excludeDomains],
				["startCrawlDate", (args as any).startCrawlDate],
				["endCrawlDate", (args as any).endCrawlDate],
				["startPublishedDate", (args as any).startPublishedDate],
				["endPublishedDate", (args as any).endPublishedDate],
				["includeText", (args as any).includeText],
				["excludeText", (args as any).excludeText],
				["moderation", (args as any).moderation],
			];

			let firstExtra = true;
			for (const [k, v] of extras) {
				if (v === undefined) continue;
				if (firstExtra) {
					out += "\n ";
					firstExtra = false;
				}
				out += ` ${theme.fg("muted", k + ":")} ${theme.fg("dim", fmtValue(v))}`;
			}

			return new Text(out, 0, 0);
		},

		renderResult(result, options: ToolRenderOptions, theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Searching Exa…"), 0, 0);
			}

			const json = getJsonBlock(result as any);
			const results: ExaSearchResult[] = Array.isArray(json?.results) ? json.results : [];
			const shown = options.expanded ? results : results.slice(0, 3);

			let out = "";
			if (json?.requestId || json?.resolvedSearchType) {
				out += "  ";
				if (json?.requestId) out += `${theme.fg("muted", "requestId:")} ${theme.fg("dim", String(json.requestId))} `;
				if (json?.resolvedSearchType) out += `${theme.fg("muted", "resolvedSearchType:")} ${theme.fg("dim", String(json.resolvedSearchType))}`;
			}

			for (let i = 0; i < shown.length; i++) {
				const r = shown[i]!;
				const title = r.title || r.url || "(no title)";
				out += `\n\n  ${theme.fg("accent", theme.bold(String(i + 1) + "."))} ${theme.fg("toolOutput", truncate(oneLine(title), 160))}`;
				if (r.url) out += `\n     ${theme.fg("dim", r.url)}`;

				const meta: string[] = [];
				if (r.author) meta.push(r.author);
				if (r.publishedDate) meta.push(r.publishedDate);
				if (typeof r.score === "number") meta.push(`score ${r.score.toFixed(3)}`);
				if (meta.length > 0) out += `\n     ${theme.fg("muted", meta.join(" · "))}`;

				const snippetSource = r.text || (r.highlights ? r.highlights.join(" \n") : "");
				const snippet = snippetSource ? truncate(oneLine(snippetSource), options.expanded ? 400 : 200) : "";
				if (snippet) out += `\n     ${theme.fg("toolOutput", snippet)}`;
			}

			if (!options.expanded && results.length > shown.length) {
				out += `\n\n  ${theme.fg("dim", `… ${results.length - shown.length} more (expand to view)`)}`;
			}
			if (shown.length === 0) out += `\n  ${theme.fg("dim", "(no results)")}`;

			return new Text(out.trim(), 0, 0);
		},

		async execute(_toolCallId, params: any, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Searching Exa…" }] });

			const body: JsonRecord = { query: params.query };

			const type = params.type;
			if (typeof type === "string" && type.trim().length > 0) body.type = type;
			if (Array.isArray(params.additionalQueries) && params.additionalQueries.length > 0) body.additionalQueries = params.additionalQueries;
			if (typeof params.category === "string" && params.category.trim().length > 0) body.category = params.category;
			if (typeof params.userLocation === "string" && params.userLocation.trim().length > 0) body.userLocation = params.userLocation;

			if (typeof params.text === "boolean") body.text = params.text;
			if (typeof params.numResults === "number") body.numResults = params.numResults;
			if (typeof params.context === "boolean") body.context = params.context;

			if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
			if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
			if (typeof params.startCrawlDate === "string" && params.startCrawlDate.trim().length > 0) body.startCrawlDate = params.startCrawlDate;
			if (typeof params.endCrawlDate === "string" && params.endCrawlDate.trim().length > 0) body.endCrawlDate = params.endCrawlDate;
			if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
			if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;
			if (Array.isArray(params.includeText) && params.includeText.length > 0) body.includeText = params.includeText;
			if (Array.isArray(params.excludeText) && params.excludeText.length > 0) body.excludeText = params.excludeText;
			if (typeof params.moderation === "boolean") body.moderation = params.moderation;

			const response = await exaPost<ExaSearchResponse>("/search", body, signal);
			const results = compactSearchResults(response.results);

			return {
				content: [
					{
						type: "text",
						text: formatSearchResultsAsText(results),
					},
					{
						type: "json",
						json: {
							requestId: response.requestId,
							resolvedSearchType: (response as any).resolvedSearchType,
							results,
							context: (response as any).context,
						},
					},
				],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "crawling_exa",
		label: "exa.crawl",
		description:
			"Fetch page contents via Exa (/contents). Use this when you already have URLs and need text, highlights, or summaries. Best practice: request only what you need (summary/highlights vs full text) to keep tool output small.",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ minLength: 1 }), {
				description: "URLs to fetch.",
				minItems: 1,
			}),

			text: Type.Optional(
				Type.Boolean({
					description: "If true, return extracted page text (can be large). If false, disable text.",
				}),
			),
			highlights: Type.Optional(
				Type.Boolean({
					description: "If true, include default highlights (relevant snippets) for each page.",
				}),
			),
			summary: Type.Optional(Type.Boolean({ description: "If true, include a default summary for each page." })),
			context: Type.Optional(
				Type.Boolean({
					description: "If true, include a combined context string (often useful for RAG, but can be very large).",
				}),
			),

			livecrawl: Type.Optional(
				Type.String({
					description:
						"Livecrawl mode: never (default), fallback, preferred, always. Use 'always' only if you cannot tolerate cached content.",
				}),
			),
			livecrawlTimeout: Type.Optional(
				Type.Integer({
					description: "Livecrawl timeout in milliseconds (default 10000).",
					minimum: 1,
				}),
			),
			subpages: Type.Optional(
				Type.Integer({
					description: "Number of subpages to crawl (default 0).",
					minimum: 0,
				}),
			),
			subpageTarget: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Keywords to target specific subpages. Exa also accepts a single string; here pass a one-element array.",
				}),
			),
		}),

		renderCall(args, theme) {
			let out = theme.fg("toolTitle", theme.bold("exa.crawl"));
			const urls = Array.isArray((args as any)?.urls) ? ((args as any).urls as string[]) : [];
			if (urls.length > 0) out += ` ${theme.fg("dim", fmtValue(urls))}`;

			const extras: Array<[string, unknown]> = [
				["text", (args as any).text],
				["highlights", (args as any).highlights],
				["summary", (args as any).summary],
				["context", (args as any).context],
				["livecrawl", (args as any).livecrawl],
				["livecrawlTimeout", (args as any).livecrawlTimeout],
				["subpages", (args as any).subpages],
				["subpageTarget", (args as any).subpageTarget],
			];

			let firstExtra = true;
			for (const [k, v] of extras) {
				if (v === undefined) continue;
				if (firstExtra) {
					out += "\n ";
					firstExtra = false;
				}
				out += ` ${theme.fg("muted", k + ":")} ${theme.fg("dim", fmtValue(v))}`;
			}
			return new Text(out, 0, 0);
		},

		renderResult(result, options: ToolRenderOptions, theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Fetching contents from Exa…"), 0, 0);
			}

			const json = getJsonBlock(result as any);
			const results: ExaContentsResult[] = Array.isArray(json?.results) ? json.results : [];
			const shown = options.expanded ? results : results.slice(0, 2);

			let out = "";
			if (json?.requestId) out += `  ${theme.fg("muted", "requestId:")} ${theme.fg("dim", String(json.requestId))}`;

			for (let i = 0; i < shown.length; i++) {
				const r = shown[i]!;
				const title = r.title || r.url || r.id || "(no title)";
				out += `\n\n  ${theme.fg("accent", theme.bold(String(i + 1) + "."))} ${theme.fg("toolOutput", truncate(oneLine(title), 160))}`;
				if (r.url) out += `\n     ${theme.fg("dim", r.url)}`;

				const meta: string[] = [];
				if (r.author) meta.push(r.author);
				if (r.publishedDate) meta.push(r.publishedDate);
				if (meta.length > 0) out += `\n     ${theme.fg("muted", meta.join(" · "))}`;

				if (typeof r.summary === "string" && r.summary.trim().length > 0) {
					out += `\n     ${theme.fg("muted", "summary:")} ${theme.fg("toolOutput", truncate(oneLine(r.summary), options.expanded ? 400 : 200))}`;
				}

				if (typeof r.text === "string" && r.text.trim().length > 0) {
					out += `\n     ${theme.fg("muted", "text:")} ${theme.fg("dim", truncate(oneLine(r.text), options.expanded ? 260 : 120))}`;
				}

				if (Array.isArray(r.highlights) && r.highlights.length > 0) {
					out += `\n     ${theme.fg("muted", `highlights: ${r.highlights.length}`)}`;
				}
			}

			if (!options.expanded && results.length > shown.length) {
				out += `\n\n  ${theme.fg("dim", `… ${results.length - shown.length} more (expand to view)`)}`;
			}
			if (shown.length === 0) out += `\n  ${theme.fg("dim", "(no results)")}`;
			return new Text(out.trim(), 0, 0);
		},

		async execute(_toolCallId, params: any, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Fetching contents from Exa…" }] });

			const urls = (params.urls || []).filter(Boolean);
			if (urls.length === 0) throw new Error("crawling_exa requires at least one url");

			const body: JsonRecord = {
				text: params.text ?? true,
				urls,
			};
			if (typeof params.context === "boolean") body.context = params.context;
			if (typeof params.highlights === "boolean") body.highlights = params.highlights;
			if (typeof params.summary === "boolean") body.summary = params.summary;
			if (params.livecrawl) body.livecrawl = params.livecrawl;
			if (typeof params.livecrawlTimeout === "number") body.livecrawlTimeout = params.livecrawlTimeout;
			if (typeof params.subpages === "number") body.subpages = params.subpages;
			if (params.subpageTarget?.length) body.subpageTarget = params.subpageTarget;

			const response = await exaPost<ExaContentsResponse>("/contents", body, signal);
			const results = compactContentsResults(response.results);

			return {
				content: [
					{
						type: "text",
						text: formatContentsResultsAsText(results),
					},
					{
						type: "json",
						json: {
							requestId: response.requestId,
							results,
							statuses: response.statuses,
							context: response.context,
							costDollars: response.costDollars,
						},
					},
				],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "get_code_context_exa",
		label: "exa.code_context",
		description:
			"Get relevant code snippets and examples via Exa Context API (Exa Code). Best practice: start with tokensNum omitted (defaults to 'dynamic') for token-efficient results; use '5000' (or '10000' if needed) when you want a fixed size.",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query to find relevant code snippets.",
				minLength: 1,
				maxLength: 2000,
			}),
			tokensNum: Type.Optional(
				Type.String({
					description:
						"Optional. Defaults to 'dynamic' (recommended). Use 'dynamic' or an integer between 50 and 100000 (as a string).",
				}),
			),
		}),

		renderCall(args, theme) {
			let out = theme.fg("toolTitle", theme.bold("exa.code_context"));
			const query = typeof (args as any)?.query === "string" ? truncate(oneLine((args as any).query), 140) : "";
			if (query) out += ` ${theme.fg("toolOutput", query)}`;

			const tokensNum = (args as any).tokensNum;
			if (typeof tokensNum === "string" && tokensNum.trim().length > 0) {
				out += `\n  ${theme.fg("muted", "tokensNum:")} ${theme.fg("dim", fmtValue(tokensNum.trim()))}`;
			}

			return new Text(out, 0, 0);
		},

		renderResult(result, options: ToolRenderOptions, theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Getting code context from Exa…"), 0, 0);
			}

			const json = getJsonBlock(result as any);
			const responseText = typeof json?.response === "string" ? json.response : "";
			if (!responseText) return new Text(theme.fg("dim", "(no response)"), 0, 0);

			if (options.expanded) {
				const mdTheme = getMarkdownTheme();
				return new Markdown(responseText, 0, 0, mdTheme);
			}

			const head = truncateLines(responseText, 20);
			let out = theme.fg("toolOutput", head.text);
			if (head.truncated) out += `\n\n${theme.fg("dim", "… (expand to view full context)")}`;
			return new Text(out.trim(), 0, 0);
		},

		async execute(_toolCallId, params: any, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Getting code context from Exa…" }] });

			const body: JsonRecord = { query: params.query };

			const rawTokensNum = typeof params.tokensNum === "string" ? params.tokensNum.trim() : "";
			if (rawTokensNum.length === 0) {
				body.tokensNum = "dynamic";
			} else if (/^\d+$/.test(rawTokensNum)) {
				const n = Number(rawTokensNum);
				if (!Number.isFinite(n) || n < 50 || n > 100000) {
					throw new Error("tokensNum must be between 50 and 100000 (or the literal 'dynamic')");
				}
				body.tokensNum = n;
			} else {
				const mode = rawTokensNum.toLowerCase();
				if (mode !== "dynamic") {
					throw new Error("tokensNum must be between 50 and 100000 (or the literal 'dynamic')");
				}
				body.tokensNum = "dynamic";
			}

			const response = await exaPost<ExaContextResponse>("/context", body, signal);

			return {
				content: [
					{
						type: "text",
						text: response.response || "(no response)",
					},
					{
						type: "json",
						json: {
							requestId: response.requestId,
							query: response.query,
							response: response.response,
							resultsCount: response.resultsCount,
							costDollars: response.costDollars,
							searchTime: response.searchTime,
							outputTokens: response.outputTokens,
						},
					},
				],
				details: response,
			};
		},
	});
}
