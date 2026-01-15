import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type JsonRecord = Record<string, unknown>;

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
	searchType?: string;
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

async function exaPost<T>(path: string, body: JsonRecord, signal?: AbortSignal): Promise<T> {
	const { baseUrl, apiKey } = getExaConfig();
	const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

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
		throw new Error(`Exa API error (${res.status} ${res.statusText}) for ${path}: ${details}`);
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
	return (results || []).map((r) => ({
		id: r.id,
		url: r.url,
		title: r.title,
		score: r.score,
		publishedDate: r.publishedDate,
		author: r.author,
		text: r.text,
		highlights: r.highlights,
	}));
}

export default function exa(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search_exa",
		label: "Exa Web Search",
		description: "Search the web via Exa (replacement for exa-mcp web_search_exa).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			text: Type.Optional(Type.Boolean({ description: "Include extracted text in results" })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Number of results" })),
			includeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only these domains" })),
			excludeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Exclude these domains" })),
			startPublishedDate: Type.Optional(
				Type.String({ description: "ISO date string (YYYY-MM-DD or full ISO)" }),
			),
			endPublishedDate: Type.Optional(Type.String({ description: "ISO date string (YYYY-MM-DD or full ISO)" })),
			searchType: Type.Optional(Type.String({ description: "Search type (per Exa API; defaults to auto)" })),
			useAutoprompt: Type.Optional(Type.Boolean({ description: "Let Exa rewrite/expand query" })),
		}),
		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Searching Exa…" }] });

			const body: JsonRecord = {
				query: params.query,
			};
			if (typeof params.text === "boolean") body.text = params.text;
			if (typeof params.numResults === "number") body.numResults = params.numResults;
			if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
			if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
			if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
			if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;
			if (params.searchType) body.searchType = params.searchType;
			if (typeof params.useAutoprompt === "boolean") body.useAutoprompt = params.useAutoprompt;

			const response = await exaPost<ExaSearchResponse>("/search", body, signal);

			return {
				content: [
					{
						type: "json",
						json: {
							requestId: response.requestId,
							searchType: response.searchType,
							results: compactSearchResults(response.results),
							context: response.context,
						},
					},
				],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "crawling_exa",
		label: "Exa Crawl",
		description: "Fetch contents (and optionally subpages) via Exa (replacement for exa-mcp crawling_exa).",
		parameters: Type.Object({
			urls: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "URLs to fetch" })),
			ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "IDs to fetch (often same as URLs)" })),
			text: Type.Optional(Type.Boolean({ description: "Include extracted text" })),
			highlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
			summary: Type.Optional(Type.Boolean({ description: "Include summary" })),
			livecrawl: Type.Optional(
				Type.String({ description: 'Live crawl mode (e.g. "preferred" or "always")' }),
			),
			livecrawlTimeout: Type.Optional(Type.Integer({ description: "Live crawl timeout in ms (e.g. 12000)" })),
			subpages: Type.Optional(Type.Integer({ minimum: 1, description: "Number of subpages to crawl" })),
			subpageTarget: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "Target subpages that match these keywords",
				}),
			),
		}),
		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Fetching contents from Exa…" }] });

			const ids = (params.ids || []).filter(Boolean);
			const urls = (params.urls || []).filter(Boolean);
			if (ids.length === 0 && urls.length === 0) {
				throw new Error("crawling_exa requires at least one of: ids or urls");
			}

			const body: JsonRecord = {
				text: params.text ?? true,
			};
			if (ids.length > 0) body.ids = ids;
			else body.urls = urls;

			if (typeof params.highlights === "boolean") body.highlights = params.highlights;
			if (typeof params.summary === "boolean") body.summary = params.summary;
			if (params.livecrawl) body.livecrawl = params.livecrawl;
			if (typeof params.livecrawlTimeout === "number") body.livecrawlTimeout = params.livecrawlTimeout;
			if (typeof params.subpages === "number") body.subpages = params.subpages;
			if (params.subpageTarget?.length) body.subpageTarget = params.subpageTarget;

			const response = await exaPost<ExaContentsResponse>("/contents", body, signal);

			return {
				content: [
					{
						type: "json",
						json: {
							requestId: response.requestId,
							results: response.results || [],
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
		label: "Exa Code Context",
		description:
			"Get relevant code snippets and examples via Exa Context API (replacement for exa-mcp get_code_context_exa).",
		parameters: Type.Object({
			query: Type.String({ description: "What code you are looking for" }),
			tokensNum: Type.Optional(
				Type.Union([
					Type.String({ description: '"dynamic" or another Exa tokens mode' }),
					Type.Integer({ description: "Specific token limit (e.g. 5000)" }),
				]),
			),
		}),
		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Getting code context from Exa…" }] });

			const body: JsonRecord = {
				query: params.query,
			};
			if (typeof params.tokensNum === "string" || typeof params.tokensNum === "number") {
				body.tokensNum = params.tokensNum;
			}

			const response = await exaPost<ExaContextResponse>("/context", body, signal);

			return {
				content: [
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
