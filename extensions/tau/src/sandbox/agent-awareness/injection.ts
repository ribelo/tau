import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

/** Minimal message shape for injection functions - content is kept loose to support all message types */
type MessageLike = { role: string; content?: unknown };

type AgentContextOpts = {
	count: number;
	pids?: number[];
};

export function buildAgentContextNotice(opts: AgentContextOpts): string {
	const count = opts.count;
	if (count <= 0) return "AGENT_CONTEXT: no other agents detected";

	const plural = count === 1 ? "" : "s";
	const pids = Array.isArray(opts.pids) ? opts.pids : [];
	const pidSuffix =
		pids.length > 0
			? ` (pids: ${pids.slice(0, 4).join(", ")}${pids.length > 4 ? ", …" : ""})`
			: "";
	return `AGENT_CONTEXT: ${count} other pi agent${plural} detected in overlapping directories${pidSuffix}`;
}

function asContentArray(
	content: unknown,
): (TextContent | ImageContent)[] {
	if (content === undefined || content === null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as (TextContent | ImageContent)[];
	return [];
}

export function injectAgentContextIntoMessages<T extends MessageLike>(
	messages: T[],
	noticeText: string,
): T[] {
	const out = [...messages];

	for (let i = out.length - 1; i >= 0; i--) {
		const msg = out[i];
		if (msg && msg.role === "user") {
			const contentArr = asContentArray(msg.content);
			const firstText =
				contentArr[0] && contentArr[0].type === "text" ? (contentArr[0] as TextContent).text : "";
			if (firstText.trimStart().startsWith("AGENT_CONTEXT:")) return out;

			const injected: TextContent = { type: "text", text: `${noticeText}\n\n` };
			out[i] = { ...msg, content: [injected, ...contentArr] };
			return out;
		}
	}

	return out;
}

