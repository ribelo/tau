import { randomUUID } from "node:crypto";
import type { Complexity } from "./types.js";

export interface TaskSession {
	sessionId: string;
	taskType: string;
	complexity: Complexity;
	createdAt: number;
	/** Canonical JSON string for result_schema, if any. */
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
	createSession(taskType: string, complexity: Complexity, sessionId?: string, outputSchemaKey?: string): TaskSession {
		if (sessionId) {
			const existing = this.sessions.get(sessionId);
			if (existing) {
				if (existing.taskType !== taskType) {
					throw new Error(`session_id ${sessionId} belongs to type=${existing.taskType}, not ${taskType}`);
				}
				if (outputSchemaKey && existing.outputSchemaKey && existing.outputSchemaKey !== outputSchemaKey) {
					throw new Error(`session_id ${sessionId} uses a different result_schema`);
				}
				if (outputSchemaKey && !existing.outputSchemaKey) {
					existing.outputSchemaKey = outputSchemaKey;
				}
				if (!outputSchemaKey && existing.outputSchemaKey) {
					throw new Error(`session_id ${sessionId} requires result_schema`);
				}
				return existing;
			}
		}

		const id = sessionId ?? randomUUID();
		const createdAt = Date.now();
		const session: TaskSession = { sessionId: id, taskType, complexity, createdAt, outputSchemaKey };
		this.sessions.set(id, session);
		return session;
	}
}
