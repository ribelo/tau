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
	results?: ExaSearchResult[];
	[extra: string]: unknown;
};

type ExaContentsResult = {
	id?: string;
	url?: string;
	title?: string;
	text?: string;
	highlights?: string[];
	summary?: string;
};

type ExaContentsResponse = {
	results?: ExaContentsResult[];
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
			// Exa accepts API keys via EXA_API_KEY (docs). Some clients use x-api-key,
			// some use Authorization. Sending both keeps this extension resilient.
			"x-api-key": apiKey,
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
}> {
	return (results || []).map((r) => ({
		id: r.id,
		url: r.url,
		title: r.title,
		score: r.score,
		publishedDate: r.publishedDate,
		author: r.author,
	}));
}

export default function exa(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search_exa",
		label: "Exa Web Search",
		description: "Search the web via Exa (replacement for exa-mcp web_search_exa).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Number of results" })),
			includeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only these domains" })),
			excludeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Exclude these domains" })),
			startPublishedDate: Type.Optional(
				Type.String({ description: "ISO date string (YYYY-MM-DD or full ISO)" }),
			),
			endPublishedDate: Type.Optional(Type.String({ description: "ISO date string (YYYY-MM-DD or full ISO)" })),
			type: Type.Optional(Type.String({ description: "Search type (per Exa API)" })),
			useAutoprompt: Type.Optional(Type.Boolean({ description: "Let Exa rewrite/expand query" })),
		}),
		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Searching Exa…" }] });

			const body: JsonRecord = {
				query: params.query,
				numResults: params.numResults ?? 10,
			};
			if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
			if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
			if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
			if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;
			if (params.type) body.type = params.type;
			if (typeof params.useAutoprompt === "boolean") body.useAutoprompt = params.useAutoprompt;

			const response = await exaPost<ExaSearchResponse>("/search", body, signal);
			const results = compactSearchResults(response.results);

			return {
				content: [{ type: "json", json: { results } }],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "crawling_exa",
		label: "Exa Crawl",
		description: "Fetch page contents via Exa (replacement for exa-mcp crawling_exa).",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ minLength: 1 }), { description: "URLs to fetch" }),
			livecrawl: Type.Optional(Type.Boolean({ description: "Use Exa live crawling if supported" })),
			text: Type.Optional(Type.Boolean({ description: "Include extracted text" })),
			highlights: Type.Optional(Type.Boolean({ description: "Include highlights if supported" })),
			summary: Type.Optional(Type.Boolean({ description: "Include summary if supported" })),
		}),
		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Fetching contents from Exa…" }] });

			const body: JsonRecord = {
				urls: params.urls,
				text: params.text ?? true,
			};
			if (typeof params.livecrawl === "boolean") body.livecrawl = params.livecrawl;
			if (typeof params.highlights === "boolean") body.highlights = params.highlights;
			if (typeof params.summary === "boolean") body.summary = params.summary;

			const response = await exaPost<ExaContentsResponse>("/contents", body, signal);

			const results = (response.results || []).map((r) => ({
				id: r.id,
				url: r.url,
				title: r.title,
				text: r.text,
				highlights: r.highlights,
				summary: r.summary,
			}));

			return {
				content: [{ type: "json", json: { results } }],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "get_code_context_exa",
		label: "Exa Code Search",
		description:
			"Search for relevant code on GitHub via Exa, then fetch the matched pages' contents (replacement for exa-mcp get_code_context_exa).",
		parameters: Type.Object({
			query: Type.String({ description: "What code you are looking for" }),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of matches" })),
			repo: Type.Optional(
				Type.String({ description: "Optional repo filter (e.g. owner/repo or full github.com URL)" }),
			),
		}),
		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			onUpdate?.({ content: [{ type: "text", text: "Searching code via Exa…" }] });

			const includeDomains = ["github.com"];

			const repoHint = (() => {
				const repo = (params.repo || "").trim();
				if (!repo) return "";

				// Best-effort: keep request schema minimal; just enrich the query string.
				if (repo.includes("github.com/")) return repo;
				if (repo.includes("/")) return `github.com/${repo}`;
				return repo;
			})();

			const query = repoHint ? `${params.query} ${repoHint}` : params.query;

			const body: JsonRecord = {
				query,
				numResults: params.numResults ?? 5,
				includeDomains,
			};

			const search = await exaPost<ExaSearchResponse>("/search", body, signal);
			const results = search.results || [];

			const ids = results.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
			const urls = results.map((r) => r.url).filter((u): u is string => typeof u === "string" && u.length > 0);

			onUpdate?.({ content: [{ type: "text", text: "Fetching code page contents…" }] });

			const contentsBody: JsonRecord = {
				text: true,
			};
			if (ids.length > 0) contentsBody.ids = ids;
			else contentsBody.urls = urls;

			const contents = await exaPost<ExaContentsResponse>("/contents", contentsBody, signal);

			return {
				content: [
					{
						type: "json",
						json: {
							query: params.query,
							searchResults: compactSearchResults(search.results),
							contents: contents.results || [],
						},
					},
				],
				details: { search, contents },
			};
		},
	});
}
