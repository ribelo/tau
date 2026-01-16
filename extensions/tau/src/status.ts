import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import https from "node:https";

const STATUS_MESSAGE_TYPE = "tau:status";

type OpenAiUsagePayload = {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: RateLimitWindowSnapshot | null;
		secondary_window?: RateLimitWindowSnapshot | null;
	} | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		balance?: string | null;
	} | null;
};

type RateLimitWindowSnapshot = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
	reset_after_seconds?: number;
};

type GeminiQuotaResponse = {
	buckets?: Array<{
		remainingAmount?: string;
		remainingFraction?: number;
		resetTime?: string;
		tokenType?: string;
		modelId?: string;
	}>;
};

type AntigravityUserStatus = {
	userStatus?: {
		name?: string;
		email?: string;
		userTier?: { name?: string };
		planStatus?: {
			availablePromptCredits?: number;
			availableFlowCredits?: number;
			planInfo?: {
				planName?: string;
				monthlyPromptCredits?: number;
				monthlyFlowCredits?: number;
			};
		};
		cascadeModelConfigData?: {
			clientModelConfigs?: Array<{
				label?: string;
				modelOrAlias?: { model?: string };
				quotaInfo?: {
					remainingFraction?: number;
					resetTime?: string;
				};
			}>;
		};
	};
};

type StatusSection<T> =
	| { ok: true; data: T }
	| { ok: false; error: string; notConfigured?: boolean };

type StatusMessageDetails = {
	openai: StatusSection<{
		email?: string;
		planType?: string;
		primary?: RateLimitRow;
		secondary?: RateLimitRow;
		hasApiKeyEnv?: boolean;
	}>;
	geminiCli: StatusSection<{
		email?: string;
		hasApiKeyEnv?: boolean;
		rows: GeminiRow[];
	}>;
	antigravity: StatusSection<{
		email?: string;
		plan?: string;
		promptCredits?: { available: number; monthly: number };
		flowCredits?: { available: number; monthly: number };
		rows: AntigravityRow[];
	}>;
	fetchedAt: number;
};

type RateLimitRow = {
	label: string;
	percentLeft?: number;
	resetsAt?: number;
};

type GeminiRow = {
	label: string;
	percentLeft?: number;
	resetsAt?: number;
};

type AntigravityRow = {
	label: string;
	percentLeft?: number;
	resetsAt?: number;
};

function envVarNameOrMissing(value: string | undefined, envVarName: string): string | undefined {
	return value ? envVarName : undefined;
}

function percentLeftFromUsedPercent(usedPercent: number | undefined): number | undefined {
	if (typeof usedPercent !== "number" || Number.isNaN(usedPercent)) return undefined;
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function percentLeftFromRemainingFraction(frac: number | undefined): number | undefined {
	if (typeof frac !== "number" || Number.isNaN(frac)) return undefined;
	return Math.max(0, Math.min(100, Math.round(frac * 100)));
}

function parseIsoTimeSeconds(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return undefined;
	return Math.floor(t / 1000);
}

function parseOpenAiUsageWindow(window: RateLimitWindowSnapshot | null | undefined): RateLimitRow | undefined {
	if (!window) return undefined;

	const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
	const minutes = seconds && seconds > 0 ? Math.ceil(seconds / 60) : undefined;
	const label = (() => {
		if (minutes === 300) return "5h limit";
		if (minutes === 10080) return "Weekly limit";
		if (minutes === 43200) return "Monthly limit";
		if (minutes) return `${minutes}m limit`;
		return "Limit";
	})();

	return {
		label,
		percentLeft: percentLeftFromUsedPercent(window.used_percent),
		resetsAt: typeof window.reset_at === "number" ? window.reset_at : undefined,
	};
}

function renderProgressBar(percentLeft: number | undefined, width: number): string {
	if (typeof percentLeft !== "number") {
		return `[${"?".repeat(width)}]`;
	}

	const clamped = Math.max(0, Math.min(100, percentLeft));
	const filled = Math.round((clamped / 100) * width);
	const empty = Math.max(0, width - filled);
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function formatTime(tsSeconds: number): { time: string; date?: string } {
	const d = new Date(tsSeconds * 1000);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const time = `${hh}:${mm}`;

	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
	if (sameDay) return { time };

	const day = String(d.getDate()).padStart(2, "0");
	const month = d.toLocaleString("en", { month: "short" });
	return { time, date: `${day} ${month}` };
}

function wrapRow(
	label: string,
	value: string,
	extra: string | undefined,
	options: { labelWidth: number; innerWidth: number },
): string[] {
	const labelCol = `${label}:`;
	const labelPadded = labelCol + " ".repeat(Math.max(0, options.labelWidth - visibleWidth(labelCol)));
	const prefix = `  ${labelPadded} `;

	const first = prefix + value;
	const lines: string[] = [];
	if (visibleWidth(first) <= options.innerWidth) {
		lines.push(first);
	} else {
		// Hard truncate value if needed.
		const maxValueWidth = Math.max(0, options.innerWidth - visibleWidth(prefix));
		lines.push(prefix + value.slice(0, maxValueWidth));
	}

	if (extra) {
		const extraLine = `  ${" ".repeat(options.labelWidth)} ${extra}`;
		if (visibleWidth(extraLine) <= options.innerWidth) {
			lines.push(extraLine);
		} else {
			const maxExtraWidth = Math.max(0, options.innerWidth - visibleWidth(`  ${" ".repeat(options.labelWidth)} `));
			lines.push(`  ${" ".repeat(options.labelWidth)} ${extra.slice(0, maxExtraWidth)}`);
		}
	}

	return lines;
}

function buildLimitRow(row: { label: string; percentLeft?: number; resetsAt?: number }): { value: string; extra?: string } {
	const bar = renderProgressBar(row.percentLeft, 20);
	const percent = typeof row.percentLeft === "number" ? `${row.percentLeft}% left` : "? left";

	let extra: string | undefined;
	if (typeof row.resetsAt === "number") {
		const fmt = formatTime(row.resetsAt);
		if (fmt.date) {
			extra = `(resets ${fmt.time} on ${fmt.date})`;
		} else {
			extra = `(resets ${fmt.time})`;
		}
	}

	return { value: `${bar} ${percent}`, extra };
}

function parseGoogleProjectToken(apiKey: string): { token: string; projectId: string } | null {
	try {
		const parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
		if (!parsed.token || !parsed.projectId) return null;
		return { token: parsed.token, projectId: parsed.projectId };
	} catch {
		return null;
	}
}

async function fetchGeminiQuota(token: string, projectId: string): Promise<GeminiQuotaResponse> {
	const url = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
			"X-Goog-Api-Client": "gl-node/22.17.0",
			"Client-Metadata": JSON.stringify({
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			}),
		},
		body: JSON.stringify({ project: projectId, user_agent: null }),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
	}

	return (await res.json()) as GeminiQuotaResponse;
}

type ExecSpec = { command: string; args: string[] };

function getPlatformProcessInfo(): { processName: string; exec: ExecSpec } {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "win32") {
		const processName = "language_server_windows_x64.exe";
		const ps = `Get-CimInstance Win32_Process -Filter \"name='${processName}'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json`;
		return { processName, exec: { command: "powershell", args: ["-NoProfile", "-Command", ps] } };
	}

	if (platform === "darwin") {
		const suffix = arch === "arm64" ? "_arm" : "";
		const processName = `language_server_macos${suffix}`;
		return { processName, exec: { command: "sh", args: ["-c", `pgrep -fl ${processName}`] } };
	}

	if (platform === "linux") {
		const suffix = arch === "arm64" ? "_arm" : "_x64";
		const processName = `language_server_linux${suffix}`;
		return { processName, exec: { command: "sh", args: ["-c", `pgrep -af ${processName}`] } };
	}

	return { processName: "language_server", exec: { command: "sh", args: ["-c", "pgrep -af language_server"] } };
}

function extractCsrfToken(cmdLine: string): string | null {
	const m = cmdLine.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
	return m?.[1] ?? null;
}

function parseWindowsProcessJson(
	json: unknown,
): { pid: number; cmdLine: string } | null {
	const items = Array.isArray(json) ? json : [json];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const record = item as { ProcessId?: number; CommandLine?: string };
		const cmdLine = record.CommandLine ?? "";
		if (!cmdLine) continue;
		const lower = cmdLine.toLowerCase();
		if (!lower.includes("antigravity")) continue;
		if (!cmdLine.includes("--csrf_token")) continue;
		const pid = record.ProcessId;
		if (typeof pid === "number" && Number.isFinite(pid)) {
			return { pid, cmdLine };
		}
	}
	return null;
}

function parseUnixProcessOutput(stdout: string, processName: string): { pid: number; cmdLine: string } | null {
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!line.includes(processName)) continue;
		if (!line.includes("--csrf_token")) continue;
		const firstSpace = line.search(/\s/);
		if (firstSpace <= 0) continue;
		const pidStr = line.slice(0, firstSpace);
		const cmdLine = line.slice(firstSpace + 1);
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isFinite(pid)) continue;
		return { pid, cmdLine };
	}
	return null;
}

function parseListeningPorts(stdout: string): number[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];

	try {
		const json = JSON.parse(trimmed) as unknown;
		if (Array.isArray(json)) {
			const ports = json
				.map((v) => (typeof v === "number" ? v : undefined))
				.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
				.map((v) => Math.trunc(v));
			return Array.from(new Set(ports)).sort((a, b) => a - b);
		}
		if (typeof json === "number" && Number.isFinite(json)) {
			return [Math.trunc(json)];
		}
	} catch {
		// ignore
	}

	const ports: number[] = [];
	const ssRegex = /LISTEN\s+\d+\s+\d+\s+(?:\*|[\d.]+|\[[\da-f:]*\]):(\d+)/i;
	const lsofRegex = /(?:TCP|UDP)\s+(?:\*|[\d.]+|\[[\da-f:]+\]):(\d+)\s+\(LISTEN\)/i;

	for (const line of stdout.split("\n")) {
		const ssMatch = line.match(ssRegex);
		if (ssMatch?.[1]) {
			const p = Number.parseInt(ssMatch[1], 10);
			if (Number.isFinite(p) && !ports.includes(p)) ports.push(p);
		}

		const lsofMatch = line.match(lsofRegex);
		if (lsofMatch?.[1]) {
			const p = Number.parseInt(lsofMatch[1], 10);
			if (Number.isFinite(p) && !ports.includes(p)) ports.push(p);
		}
	}

	ports.sort((a, b) => a - b);
	return ports;
}

function getPortListCommand(pid: number): ExecSpec {
	const platform = process.platform;
	if (platform === "win32") {
		const ps = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json`;
		return { command: "powershell", args: ["-NoProfile", "-Command", ps] };
	}

	if (platform === "darwin") {
		return { command: "sh", args: ["-c", `lsof -iTCP -sTCP:LISTEN -n -P -p ${pid}`] };
	}

	if (platform === "linux") {
		return {
			command: "sh",
			args: [
				"-c",
				`ss -tlnp 2>/dev/null | grep \"pid=${pid}\" || lsof -iTCP -sTCP:LISTEN -n -P -p ${pid} 2>/dev/null`,
			],
		};
	}

	return { command: "sh", args: ["-c", `lsof -iTCP -sTCP:LISTEN -n -P -p ${pid}`] };
}

async function execSpec(pi: ExtensionAPI, spec: ExecSpec, signal?: AbortSignal) {
	return await pi.exec(spec.command, spec.args, { signal });
}

async function fetchAntigravityStatus(pi: ExtensionAPI, signal?: AbortSignal): Promise<AntigravityUserStatus> {
	const { processName, exec } = getPlatformProcessInfo();
	const proc = await execSpec(pi, exec, signal);
	const stdout = proc.stdout ?? "";

	if (!stdout.trim()) {
		throw new Error("Antigravity language server process not found");
	}

	let pid: number | undefined;
	let cmdLine: string | undefined;

	try {
		const json = JSON.parse(stdout.trim()) as unknown;
		const parsed = parseWindowsProcessJson(json);
		if (parsed) {
			pid = parsed.pid;
			cmdLine = parsed.cmdLine;
		}
	} catch {
		// ignore
	}

	if (pid === undefined || cmdLine === undefined) {
		const parsed = parseUnixProcessOutput(stdout, processName);
		if (!parsed) {
			throw new Error("Antigravity language server process not found");
		}
		pid = parsed.pid;
		cmdLine = parsed.cmdLine;
	}

	const csrfToken = extractCsrfToken(cmdLine);
	if (!csrfToken) {
		throw new Error("CSRF token not found in language server command line");
	}

	const portExec = getPortListCommand(pid);
	const portsOut = await execSpec(pi, portExec, signal);
	const ports = parseListeningPorts(portsOut.stdout ?? "");
	if (ports.length === 0) {
		throw new Error("No listening ports found for language server");
	}

	let lastError: unknown;
	for (const port of ports) {
		try {
			return await fetchAntigravityUserStatus(port, csrfToken, signal);
		} catch (err) {
			lastError = err;
		}
	}

	throw new Error(`Failed to connect to any language server port${lastError ? `: ${String(lastError)}` : ""}`);
}

async function fetchAntigravityUserStatus(
	port: number,
	csrfToken: string,
	signal?: AbortSignal,
): Promise<AntigravityUserStatus> {
	const body = JSON.stringify({
		metadata: {
			ideName: "codex",
			extensionName: "codex",
			locale: "en",
		},
	});

	return await new Promise((resolve, reject) => {
		const req = https.request(
			{
				host: "127.0.0.1",
				port,
				path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
				method: "POST",
				rejectUnauthorized: false,
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					"X-Codeium-Csrf-Token": csrfToken,
				},
				timeout: 5000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf-8");
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						try {
							resolve(JSON.parse(text) as AntigravityUserStatus);
						} catch (err) {
							reject(new Error(`Invalid JSON response: ${String(err)}`));
						}
						return;
					}
					reject(new Error(`HTTP ${res.statusCode ?? 0}`));
				});
			},
		);

		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy(new Error("timeout"));
		});
		if (signal) {
			if (signal.aborted) {
				req.destroy(new Error("aborted"));
				reject(new Error("aborted"));
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					req.destroy(new Error("aborted"));
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		}

		req.write(body);
		req.end();
	});
}

async function fetchOpenAiUsage(
	token: string,
	options: { accountId?: string },
): Promise<OpenAiUsagePayload> {
	const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			...(options.accountId ? { "ChatGPT-Account-Id": options.accountId } : {}),
			"User-Agent": "pi",
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
	}
	return (await res.json()) as OpenAiUsagePayload;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function formatPlanType(planType: string | undefined): string | undefined {
	if (!planType) return undefined;
	const t = planType.trim();
	if (!t) return undefined;
	return t.charAt(0).toUpperCase() + t.slice(1);
}

function buildStatusText(details: StatusMessageDetails, width: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const lines: string[] = [];

	const pushSectionTitle = (title: string) => {
		lines.push(` ${title}`);
	};

	const pushBlank = () => {
		lines.push("");
	};

	// OpenAI
	pushSectionTitle("OpenAI");
	if (!details.openai.ok) {
		lines.push(`  ${details.openai.notConfigured ? "Not configured" : `Error: ${details.openai.error}`}`);
	} else {
		const openai = details.openai.data;
		const labelWidth = Math.max(
			...[
				"ChatGPT",
				"API Key",
				openai.primary?.label ?? "",
				openai.secondary?.label ?? "",
			]
				.filter(Boolean)
				.map((s) => visibleWidth(`${s}:`)),
		);

		const chatgptValue = (() => {
			const email = openai.email;
			const planLabel = formatPlanType(openai.planType);
			const plan = planLabel ? `(${planLabel})` : undefined;
			if (email && plan) return `${email} ${plan}`;
			if (email) return email;
			if (plan) return plan;
			return "(not logged in)";
		})();

		lines.push(...wrapRow("ChatGPT", chatgptValue, undefined, { labelWidth, innerWidth }));

		const apiKeyLine = envVarNameOrMissing(openai.hasApiKeyEnv ? "1" : undefined, "OPENAI_API_KEY");
		lines.push(...wrapRow("API Key", apiKeyLine ?? "(not set)", undefined, { labelWidth, innerWidth }));

		if (openai.primary) {
			const row = buildLimitRow(openai.primary);
			lines.push(...wrapRow(openai.primary.label, row.value, row.extra, { labelWidth, innerWidth }));
		}
		if (openai.secondary) {
			const row = buildLimitRow(openai.secondary);
			lines.push(...wrapRow(openai.secondary.label, row.value, row.extra, { labelWidth, innerWidth }));
		}
	}

	pushBlank();

	// Gemini CLI
	pushSectionTitle("Gemini CLI");
	if (!details.geminiCli.ok) {
		lines.push(`  ${details.geminiCli.notConfigured ? "Not configured" : `Error: ${details.geminiCli.error}`}`);
	} else {
		const gemini = details.geminiCli.data;
		const labels = ["OAuth", "API Key", ...gemini.rows.map((r) => r.label)];
		const labelWidth = Math.max(...labels.map((s) => visibleWidth(`${s}:`)));

		lines.push(...wrapRow("OAuth", gemini.email ?? "(not logged in)", undefined, { labelWidth, innerWidth }));
		const apiKeyLine = envVarNameOrMissing(gemini.hasApiKeyEnv ? "1" : undefined, "GEMINI_API_KEY");
		lines.push(...wrapRow("API Key", apiKeyLine ?? "(not set)", undefined, { labelWidth, innerWidth }));

		for (const r of gemini.rows) {
			const row = buildLimitRow({ label: r.label, percentLeft: r.percentLeft, resetsAt: r.resetsAt });
			lines.push(...wrapRow(r.label, row.value, row.extra, { labelWidth, innerWidth }));
		}
	}

	pushBlank();

	// Antigravity
	pushSectionTitle("Antigravity");
	if (!details.antigravity.ok) {
		lines.push(
			`  ${details.antigravity.notConfigured ? "Not running" : `Error: ${details.antigravity.error}`}`,
		);
	} else {
		const ag = details.antigravity.data;
		const labels = [
			"OAuth",
			"Plan",
			"Prompt credits",
			"Flow credits",
			...ag.rows.map((r) => r.label),
		];
		const labelWidth = Math.max(...labels.map((s) => visibleWidth(`${s}:`)));

		lines.push(...wrapRow("OAuth", ag.email ?? "(unknown)", undefined, { labelWidth, innerWidth }));
		if (ag.plan) {
			lines.push(...wrapRow("Plan", ag.plan, undefined, { labelWidth, innerWidth }));
		}
		if (ag.promptCredits) {
			lines.push(
				...wrapRow(
					"Prompt credits",
					`${ag.promptCredits.available} / ${ag.promptCredits.monthly} monthly`,
					undefined,
					{ labelWidth, innerWidth },
				),
			);
		}
		if (ag.flowCredits) {
			lines.push(
				...wrapRow(
					"Flow credits",
					`${ag.flowCredits.available} / ${ag.flowCredits.monthly} monthly`,
					undefined,
					{ labelWidth, innerWidth },
				),
			);
		}

		for (const r of ag.rows) {
			const row = buildLimitRow({ label: r.label, percentLeft: r.percentLeft, resetsAt: r.resetsAt });
			lines.push(...wrapRow(r.label, row.value, row.extra, { labelWidth, innerWidth }));
		}
	}

	// Fit to width
	return lines.map((l) => (visibleWidth(l) <= innerWidth ? l : l.slice(0, innerWidth)));
}

class StatusCard implements Component {
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private details: StatusMessageDetails,
		private theme: any,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;

		const th = this.theme;
		const innerWidth = Math.max(1, width - 2);
		const content = buildStatusText(this.details, width);

		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (contentLine: string) => th.fg("border", "│") + pad(contentLine, innerWidth) + th.fg("border", "│");

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		for (const line of content) {
			lines.push(row(line));
		}
		lines.push(th.fg("border", `╰${"─".repeat(innerWidth)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}

export default function tauStatus(pi: ExtensionAPI) {
	pi.registerMessageRenderer<StatusMessageDetails>(STATUS_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as StatusMessageDetails | undefined;
		if (!details) {
			const text = typeof message.content === "string" ? message.content : "";
			return new Text(text, 0, 0);
		}
		return new StatusCard(details, theme);
	});

	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(m: any) => !(m?.role === "custom" && m?.customType === STATUS_MESSAGE_TYPE),
		);
		return { messages: filtered };
	});

	pi.registerCommand("status", {
		description: "Show quotas and limits (OpenAI, Gemini CLI, Antigravity)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("status requires interactive mode", "error");
				return;
			}

			ctx.ui.setStatus("tau:status", "Fetching quotas...");
			try {
				// Avoid interfering with an active agent run. This ensures we don't inject steering/follow-up.
				await ctx.waitForIdle();

				const fetchedAt = Date.now();

				const openaiPromise = (async (): Promise<StatusMessageDetails["openai"]> => {
					const cred = ctx.modelRegistry.authStorage.get("openai-codex") as
						| { type: string; access?: string; accountId?: string; email?: string }
						| undefined;
					const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
					if (!token) {
						return { ok: false, error: "Not logged in", notConfigured: true };
					}

					const usage = await fetchOpenAiUsage(token, { accountId: cred?.accountId });
					const primary = parseOpenAiUsageWindow(usage.rate_limit?.primary_window ?? undefined);
					const secondary = parseOpenAiUsageWindow(usage.rate_limit?.secondary_window ?? undefined);

					const email = (() => {
						if (cred?.email) return cred.email;
						const payload = decodeJwtPayload(token);
						const jwtEmail = payload && typeof payload.email === "string" ? payload.email : undefined;
						return jwtEmail;
					})();

					return {
						ok: true,
						data: {
							email,
							planType: usage.plan_type,
							primary,
							secondary,
							hasApiKeyEnv: Boolean(process.env.OPENAI_API_KEY),
						},
					};
				})();

				const geminiPromise = (async (): Promise<StatusMessageDetails["geminiCli"]> => {
					const apiKey = await ctx.modelRegistry.getApiKeyForProvider("google-gemini-cli");
					const cred = ctx.modelRegistry.authStorage.get("google-gemini-cli") as
						| { type: string; email?: string }
						| undefined;
					if (!apiKey) {
						return { ok: false, error: "Not logged in", notConfigured: true };
					}

					const parsed = parseGoogleProjectToken(apiKey);
					if (!parsed) {
						return { ok: false, error: "Missing Google projectId" };
					}

					const quota = await fetchGeminiQuota(parsed.token, parsed.projectId);
					const buckets = quota.buckets ?? [];
					const rows: GeminiRow[] = buckets
						.filter((b) => b.modelId && b.tokenType)
						.map((b) => {
							const model = b.modelId ?? "";
							const tokenType = b.tokenType ?? "";
							return {
								label: `${model} (${tokenType})`,
								percentLeft: percentLeftFromRemainingFraction(b.remainingFraction),
								resetsAt: parseIsoTimeSeconds(b.resetTime),
							};
						});

					rows.sort((a, b) => a.label.localeCompare(b.label));

					return {
						ok: true,
						data: {
							email: cred?.email,
							hasApiKeyEnv: Boolean(process.env.GEMINI_API_KEY),
							rows,
						},
					};
				})();

				const antigravityPromise = (async (): Promise<StatusMessageDetails["antigravity"]> => {
					const status = await fetchAntigravityStatus(pi);
					const user = status.userStatus;
					const planName = user?.planStatus?.planInfo?.planName;
					const tierName = user?.userTier?.name;
					const plan = [planName, tierName].filter(Boolean).join(" (") + (planName && tierName ? ")" : "");

					const promptAvail = user?.planStatus?.availablePromptCredits;
					const promptMonthly = user?.planStatus?.planInfo?.monthlyPromptCredits;
					const flowAvail = user?.planStatus?.availableFlowCredits;
					const flowMonthly = user?.planStatus?.planInfo?.monthlyFlowCredits;

					const configs = user?.cascadeModelConfigData?.clientModelConfigs ?? [];
					const rows: AntigravityRow[] = configs
						.filter((c) => c.label && c.quotaInfo?.remainingFraction !== undefined)
						.map((c) => ({
							label: c.label ?? c.modelOrAlias?.model ?? "(unknown)",
							percentLeft: percentLeftFromRemainingFraction(c.quotaInfo?.remainingFraction),
							resetsAt: parseIsoTimeSeconds(c.quotaInfo?.resetTime),
						}));

					rows.sort((a, b) => a.label.localeCompare(b.label));

					return {
						ok: true,
						data: {
							email: user?.email,
							plan: plan || undefined,
							promptCredits:
								typeof promptAvail === "number" && typeof promptMonthly === "number"
									? { available: promptAvail, monthly: promptMonthly }
									: undefined,
							flowCredits:
								typeof flowAvail === "number" && typeof flowMonthly === "number"
									? { available: flowAvail, monthly: flowMonthly }
									: undefined,
							rows,
						},
					};
				})();

				const toErrorString = (e: unknown): string => {
					if (e instanceof Error) {
						return e.stack || e.message;
					}
					return String(e);
				};

				const [openai, geminiCli, antigravity] = await Promise.all([
					openaiPromise.catch((e: unknown) => ({ ok: false, error: toErrorString(e) }) as StatusMessageDetails["openai"]),
					geminiPromise.catch((e: unknown) => ({ ok: false, error: toErrorString(e) }) as StatusMessageDetails["geminiCli"]),
					antigravityPromise.catch((e: unknown) => {
						const msg = toErrorString(e);
						const notConfigured = /process not found|language server process not found/i.test(msg);
						return { ok: false, error: msg, notConfigured } as StatusMessageDetails["antigravity"];
					}),
				]);

				pi.sendMessage(
					{
						customType: STATUS_MESSAGE_TYPE,
						content: "",
						display: true,
						details: {
							openai,
							geminiCli,
							antigravity,
							fetchedAt,
						} satisfies StatusMessageDetails,
					},
					{ triggerTurn: false },
				);
			} finally {
				ctx.ui.setStatus("tau:status", undefined);
			}
		},
	});
}
