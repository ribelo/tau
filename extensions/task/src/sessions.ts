import { randomUUID } from "node:crypto";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Difficulty } from "./types.js";

export interface TaskSession {
	sessionId: string;
	taskType: string;
	difficulty: Difficulty;
	createdAt: number;
	/** In-process worker session (when using in-process backend). */
	workerSession?: AgentSession;
	/** Recorded nesting depth for this task session. */
	nestingDepth?: number;
	/** Canonical JSON string for output_schema, if any. */
	outputSchemaKey?: string;
}

export class SessionManager {
	private readonly sessions = new Map<string, TaskSession>();

	constructor() {}

	getSession(sessionId: string): TaskSession | undefined {
		return this.sessions.get(sessionId);
	}

	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/**
	 * Create a new session or return an existing one.
	 *
	 * If sessionId is provided and exists, validates it matches taskType.
	 */
	createSession(taskType: string, difficulty: Difficulty, sessionId?: string, outputSchemaKey?: string): TaskSession {
		if (sessionId) {
			const existing = this.sessions.get(sessionId);
			if (existing) {
				if (existing.taskType !== taskType) {
					throw new Error(
						`session_id ${sessionId} belongs to task_type=${existing.taskType}, not ${taskType}`,
					);
				}
				if (outputSchemaKey && existing.outputSchemaKey && existing.outputSchemaKey !== outputSchemaKey) {
					throw new Error(`session_id ${sessionId} uses a different output_schema`);
				}
				if (outputSchemaKey && !existing.outputSchemaKey) {
					existing.outputSchemaKey = outputSchemaKey;
				}
				if (!outputSchemaKey && existing.outputSchemaKey) {
					throw new Error(`session_id ${sessionId} requires output_schema`);
				}
				return existing;
			}
		}

		const id = sessionId ?? randomUUID();
		const createdAt = Date.now();
		const session: TaskSession = { sessionId: id, taskType, difficulty, createdAt, outputSchemaKey };
		this.sessions.set(id, session);
		return session;
	}

	setWorkerSession(sessionId: string, workerSession: AgentSession | undefined, nestingDepth?: number) {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		s.workerSession = workerSession;
		if (nestingDepth !== undefined) s.nestingDepth = nestingDepth;
	}
}
