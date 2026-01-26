import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import https from "node:https";

import type { TauState } from "../shared/state.js";
import { updatePersistedState } from "../shared/state.js";

const STATUS_MESSAGE_TYPE = "tau:status";

type Theme = {
	fg: (key: string, s: string) => string;
	bold: (s: string) => string;
};

type StatusState = {
	fetchedAt: number;
	values: Record<string, { percentLeft: number }>;
};

type BurnInfo = {
	burnRatePerHour?: number | undefined;
	exhaustsAt?: number | undefined;
	exhaustsBeforeReset?: boolean | undefined;
};

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

type StatusRow = {
	label: string;
	subLabel?: string;
	percentLeft?: number;
	resetsAt?: number;
	burnRatePerHour?: number;
	exhaustsAt?: number;
	exhaustsBeforeReset?: boolean;
	isDepleted?: boolean;
};

type StatusSectionData = {
	title: string;
	statusLine?: string; // e.g. "[Pro] [Key: Configured]"
	error?: string;
	notConfigured?: boolean;
	rows: StatusRow[];
};

type StatusMessageDetails = {
	sections: StatusSectionData[];
	fetchedAt: number;
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
	return Math.max(0, Math.min(100, frac * 100));
}

function parseIsoTimeSeconds(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return undefined;
	return Math.floor(t / 1000);
}

function computeBurnAndExhaust(
	prev: StatusState | undefined,
	key: string,
	fetchedAtMs: number,
	currentPercentLeft: number | undefined,
	resetsAt: number | undefined,
	windowSeconds?: number,
): { burnRatePerHour?: number; exhaustsAt?: number; exhaustsBeforeReset?: boolean } {
	if (typeof currentPercentLeft !== "number" || !Number.isFinite(currentPercentLeft)) return {};

	let burnRatePerHour: number | undefined;

	// Method 1: If we know the window size, we can calculate the average burn since window start.
	if (typeof windowSeconds === "number" && windowSeconds > 0 && typeof resetsAt === "number") {
		const windowStartMs = resetsAt * 1000 - windowSeconds * 1000;
		const elapsedMs = fetchedAtMs - windowStartMs;
		const elapsedHours = elapsedMs / (1000 * 60 * 60);
		if (elapsedHours > 0.01) {
			const usedPercent = 100 - currentPercentLeft;
			burnRatePerHour = usedPercent / elapsedHours;
		}
	}

	// Method 2: Fallback to sample-based burn rate if Method 1 fails or isn't available.
	if ((burnRatePerHour === undefined || burnRatePerHour < 0.01) && prev) {
		const prevPercentLeft = prev.values[key]?.percentLeft;
		if (typeof prevPercentLeft === "number" && Number.isFinite(prevPercentLeft)) {
			const elapsedMs = fetchedAtMs - prev.fetchedAt;
			const elapsedHours = elapsedMs / (1000 * 60 * 60);
			if (elapsedHours > 0.01) {
				const usedPercent = prevPercentLeft - currentPercentLeft;
				if (usedPercent > 0) {
					burnRatePerHour = usedPercent / elapsedHours;
				}
			}
		}
	}

	if (typeof burnRatePerHour !== "number" || !Number.isFinite(burnRatePerHour) || burnRatePerHour < 0.01) {
		return {};
	}

	const exhaustHours = currentPercentLeft / burnRatePerHour;
	const exhaustsAtMs = fetchedAtMs + exhaustHours * 60 * 60 * 1000;
	const exhaustsAt = Math.floor(exhaustsAtMs / 1000);
	const exhaustsBeforeReset = typeof resetsAt === "number" ? exhaustsAt < resetsAt : undefined;

	return { burnRatePerHour, exhaustsAt, exhaustsBeforeReset };
}

function mapOpenAiRow(
	window: RateLimitWindowSnapshot | null | undefined,
	prev: StatusState | undefined,
	fetchedAtMs: number,
): StatusRow | undefined {
	if (!window) return undefined;

	const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
	const minutes = seconds && seconds > 0 ? Math.ceil(seconds / 60) : undefined;
	const label = (() => {
		if (minutes === 300) return "5h Limit";
		if (minutes === 10080) return "Weekly Limit";
		if (minutes === 43200) return "Monthly Limit";
		if (minutes) return `${minutes}m Limit`;
		return "Limit";
	})();

	const resetsAt = typeof window.reset_at === "number" ? window.reset_at : undefined;
	const usedPercent = typeof window.used_percent === "number" ? window.used_percent : undefined;
	const percentLeft = percentLeftFromUsedPercent(usedPercent);

	const metrics = computeBurnAndExhaust(prev, `openai:${label}`, fetchedAtMs, percentLeft, resetsAt, seconds);

	return {
		label,
		percentLeft,
		resetsAt,
		isDepleted: percentLeft === 0,
		...metrics,
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

function buildStatusLines(section: StatusSectionData, width: number, th: Theme, fetchedAtMs: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const lines: string[] = [];

	if (section.error) {
		const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
		lines.push(`  ${section.notConfigured ? th.fg("dim", "Not configured") : `${th.fg("error", "Error:")} ${oneLine(section.error)}`}`);
		return lines;
	}

	if (section.rows.length === 0 && section.notConfigured) {
		lines.push(`  ${th.fg("dim", "Not configured")}`);
		return lines;
	}

	for (let i = 0; i < section.rows.length; i++) {
		const row = section.rows[i]!;
		if (i > 0) lines.push("");

		// Title line
		lines.push(` ${row.label}${row.subLabel ? th.fg("dim", ` (${row.subLabel})`) : ""}`);

		// Progress bar line
		const bar = renderProgressBar(row.percentLeft, 20);
		const pct = typeof row.percentLeft === "number" ? Math.round(row.percentLeft) : undefined;
		const percent = typeof pct === "number" ? `${pct}% Left` : "?% Left";
		const depletedText = row.isDepleted ? th.fg("error", " (Depleted)") : "";
		lines.push(` ${bar} ${percent}${depletedText}`);

		// Metadata line (Burn, Reset, Depletes)
		const metadata: string[] = [];
		if (typeof row.resetsAt === "number") {
			const fmt = formatTime(row.resetsAt);
			metadata.push(`Reset: ${fmt.date ? `${fmt.date} ${fmt.time}` : fmt.time}`);
		}

		if (typeof row.burnRatePerHour === "number" && Number.isFinite(row.burnRatePerHour)) {
			metadata.push(`Burn: ${row.burnRatePerHour.toFixed(1)}%/h`);
		}

		if (row.isDepleted) {
			metadata.push(th.fg("error", "Limit Reached. Waiting for reset."));
		} else if (typeof row.exhaustsAt === "number") {
			const fmt = formatTime(row.exhaustsAt);
			const base = fmt.date ? `${fmt.date} ${fmt.time}` : fmt.time;
			const color = row.exhaustsBeforeReset ? "error" : "success";
			const label = row.exhaustsBeforeReset ? "Depletes" : "Safe";
			metadata.push(`${label}: ${th.fg(color, base)}`);
		} else if (typeof row.percentLeft === "number" && row.percentLeft === 100) {
			metadata.push(th.fg("success", "Safe"));
		}

		if (metadata.length > 0) {
			lines.push(` ${th.fg("dim", "└─")} ${metadata.join(th.fg("dim", " · "))}`);
		}
	}

	return lines;
}

class StatusCard implements Component {
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private details: StatusMessageDetails,
		private theme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;

		const th = this.theme;
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - w));
		};

		const drawBox = (section: StatusSectionData) => {
			// Header
			const title = ` ${th.bold(section.title)}`;
			const status = section.statusLine ? `${section.statusLine} ` : "";
			const headerPadding = innerWidth - visibleWidth(title) - visibleWidth(status);
			
			lines.push(th.fg("border", "╭") + th.fg("border", "─".repeat(innerWidth)) + th.fg("border", "╮"));
			lines.push(th.fg("border", "│") + title + " ".repeat(Math.max(0, headerPadding)) + status + th.fg("border", "│"));
			lines.push(th.fg("border", "├") + th.fg("border", "─".repeat(innerWidth)) + th.fg("border", "┤"));

			// Content
			const content = buildStatusLines(section, width, th, this.details.fetchedAt);
			for (const line of content) {
				lines.push(th.fg("border", "│") + pad(line, innerWidth) + th.fg("border", "│"));
			}

			// Footer
			lines.push(th.fg("border", "╰") + th.fg("border", "─".repeat(innerWidth)) + th.fg("border", "╯"));
		};

		for (let i = 0; i < this.details.sections.length; i++) {
			if (i > 0) lines.push("");
			drawBox(this.details.sections[i]!);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
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
			"User-Agent": "google-api-nodejs-client/9.15.1",
			"X-Goog-Api-Client": "gl-node/22.17.0",
			"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
		},
		body: JSON.stringify({ project: projectId }),
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
		const ps = `Get-CimInstance Win32_Process -Filter "name='${processName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json`;
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
	const m = cmdLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/);
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
				`ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -iTCP -sTCP:LISTEN -n -P -p ${pid} 2>/dev/null`,
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

export default function initStatus(pi: ExtensionAPI, state: TauState) {
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
			(m) => !(m?.role === "custom" && m?.customType === STATUS_MESSAGE_TYPE),
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
				await ctx.waitForIdle();

				const fetchedAt = Date.now();
				const prevState = (() => {
					const data = state.persisted?.status;
					if (!data || typeof data !== "object") return undefined;
					const candidate = data as { fetchedAt?: unknown; values?: unknown };
					if (typeof candidate.fetchedAt !== "number") return undefined;
					if (!candidate.values || typeof candidate.values !== "object") return undefined;
					return candidate as StatusState;
				})();

				const nextState: StatusState = { fetchedAt, values: {} };

				const openaiPromise = (async (): Promise<StatusSectionData> => {
					const cred = ctx.modelRegistry.authStorage.get("openai-codex") as
						| { type: string; access?: string; accountId?: string; email?: string }
						| undefined;
					const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
					if (!token) {
						return { title: "OpenAI", notConfigured: true, rows: [] };
					}

					const usage = await fetchOpenAiUsage(token, { accountId: cred?.accountId });
					const plan = formatPlanType(usage.plan_type);
					const hasKey = Boolean(process.env.OPENAI_API_KEY);
					const statusLine = `[${plan ?? "Pro"}] [Key: ${hasKey ? "Configured" : "Not set"}]`;

					const rows: StatusRow[] = [];
					const p = mapOpenAiRow(usage.rate_limit?.primary_window, prevState, fetchedAt);
					if (p) rows.push(p);
					const s = mapOpenAiRow(usage.rate_limit?.secondary_window, prevState, fetchedAt);
					if (s) rows.push(s);

					for (const r of rows) {
						if (typeof r.percentLeft === "number") {
							nextState.values[`openai:${r.label}`] = { percentLeft: r.percentLeft };
						}
					}

					return { title: "OpenAI", statusLine, rows };
				})();

				const geminiPromise = (async (): Promise<StatusSectionData> => {
					let provider: "google-gemini-cli" | "google-antigravity" = "google-gemini-cli";
					let apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
					if (!apiKey) {
						provider = "google-antigravity";
						apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
					}

					const cred = ctx.modelRegistry.authStorage.get(provider) as | { type: string; email?: string } | undefined;
					const statusLine = `[${cred?.email ? cred.email : "Not logged in"}]`;

					if (!apiKey) {
						return { title: "Gemini CLI", notConfigured: true, rows: [], statusLine };
					}

					const parsed = parseGoogleProjectToken(apiKey);
					if (!parsed) {
						return { title: "Gemini CLI", error: "Missing Google projectId", rows: [], statusLine };
					}

					const quota = await fetchGeminiQuota(parsed.token, parsed.projectId);
					const buckets = quota.buckets ?? [];

					const groupRows: StatusRow[] = [];
					const tiers = [
						{ label: "Flash Tier", subLabel: "2.0, 2.5, 3-Pre", pattern: /flash/i, exclude: /lite/i },
						{ label: "Pro Tier", subLabel: "2.5, 3-Pre", pattern: /pro/i },
						{ label: "Lite Tier", subLabel: "2.5-Lite", pattern: /lite/i },
					];

					for (const tier of tiers) {
						const tierBuckets = buckets.filter(b => 
							b.modelId && tier.pattern.test(b.modelId) && (!tier.exclude || !tier.exclude.test(b.modelId))
						);
						if (tierBuckets.length > 0) {
							const b = tierBuckets[0]!;
							const percentLeft = percentLeftFromRemainingFraction(b.remainingFraction) ?? 0;
							const resetsAt = parseIsoTimeSeconds(b.resetTime);
							const metrics = computeBurnAndExhaust(prevState, `gemini-cli:${tier.label}`, fetchedAt, percentLeft, resetsAt, 86400);
							groupRows.push({
								label: tier.label,
								subLabel: tier.subLabel,
								percentLeft,
								resetsAt,
								isDepleted: percentLeft === 0,
								...metrics
							});
							nextState.values[`gemini-cli:${tier.label}`] = { percentLeft };
						}
					}

					return { title: "Gemini CLI", statusLine, rows: groupRows };
				})();

				const antigravityPromise = (async (): Promise<StatusSectionData> => {
					const status = await fetchAntigravityStatus(pi);
					const user = status.userStatus;
					const email = user?.email ?? "Unknown";
					const planName = user?.planStatus?.planInfo?.planName;
					const tierName = user?.userTier?.name;
					const plan = [planName, tierName].filter(Boolean).join(" (") + (planName && tierName ? ")" : "");
					const statusLine = `[${email}]${plan ? ` [${plan}]` : ""}`;

					const configs = user?.cascadeModelConfigData?.clientModelConfigs ?? [];
					
					const rows: StatusRow[] = [];
					
					const proConfigs = configs.filter(c => c.label?.toLowerCase().includes("pro"));
					if (proConfigs.length > 0) {
						const c = proConfigs[0]!;
						const percentLeft = percentLeftFromRemainingFraction(c.quotaInfo?.remainingFraction) ?? 0;
						const resetsAt = parseIsoTimeSeconds(c.quotaInfo?.resetTime);
						const metrics = computeBurnAndExhaust(prevState, `antigravity:Pro`, fetchedAt, percentLeft, resetsAt, 18000); // 5h heuristic
						rows.push({
							label: "Gemini 3 Pro",
							subLabel: "High/Low",
							percentLeft,
							resetsAt,
							isDepleted: percentLeft === 0,
							...metrics
						});
						nextState.values[`antigravity:Pro`] = { percentLeft };
					}

					const flashConfigs = configs.filter(c => c.label?.toLowerCase().includes("flash"));
					if (flashConfigs.length > 0) {
						const c = flashConfigs[0]!;
						const percentLeft = percentLeftFromRemainingFraction(c.quotaInfo?.remainingFraction) ?? 0;
						const resetsAt = parseIsoTimeSeconds(c.quotaInfo?.resetTime);
						const metrics = computeBurnAndExhaust(prevState, `antigravity:Flash`, fetchedAt, percentLeft, resetsAt, 18000); // 5h heuristic
						rows.push({
							label: "Gemini 3 Flash",
							percentLeft,
							resetsAt,
							isDepleted: percentLeft === 0,
							...metrics
						});
						nextState.values[`antigravity:Flash`] = { percentLeft };
					} else {
						rows.push({
							label: "Gemini 3 Flash",
							percentLeft: 0,
							isDepleted: true,
						});
					}

					return { title: "Antigravity", statusLine, rows };
				})();

				const toErrorString = (e: unknown): string => {
					if (e instanceof Error) {
						return e.message;
					}
					return String(e);
				};

				const results = await Promise.allSettled([openaiPromise, geminiPromise, antigravityPromise]);
				const sections: StatusSectionData[] = results.map((r, i) => {
					if (r.status === "fulfilled") return r.value;
					const titles = ["OpenAI", "Gemini CLI", "Antigravity"];
					const title = titles[i]!;
					const msg = toErrorString(r.reason);
					const notConfigured = /process not found|language server process not found|not logged in/i.test(msg);
					return { title, error: msg, notConfigured, rows: [] };
				});

				if (Object.keys(nextState.values).length > 0) {
					updatePersistedState(pi, state, { status: nextState });
				}

				pi.sendMessage(
					{
						customType: STATUS_MESSAGE_TYPE,
						content: "",
						display: true,
						details: {
							sections,
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
