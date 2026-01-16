import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Difficulty } from "./types.js";

export interface TaskSession {
	sessionId: string;
	taskType: string;
	difficulty: Difficulty;
	/** The currently running worker process for this session (if any). */
	process?: ChildProcess;
	createdAt: number;
	/** Session file path used to persist transcript across resumptions in this parent process. */
	sessionFile: string;
}

function ensureDir(dir: string) {
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// ignore
	}
}

export class SessionManager {
	private readonly sessions = new Map<string, TaskSession>();
	private readonly baseDir: string;

	constructor() {
		this.baseDir = path.join(os.tmpdir(), "pi-task-sessions");
		ensureDir(this.baseDir);
	}

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
	createSession(taskType: string, difficulty: Difficulty, sessionId?: string): TaskSession {
		if (sessionId) {
			const existing = this.sessions.get(sessionId);
			if (existing) {
				if (existing.taskType !== taskType) {
					throw new Error(
						`session_id ${sessionId} belongs to task_type=${existing.taskType}, not ${taskType}`,
					);
				}
				return existing;
			}
		}

		const id = sessionId ?? randomUUID();
		const sessionFile = path.join(this.baseDir, `${id}.jsonl`);
		const createdAt = Date.now();
		const session: TaskSession = { sessionId: id, taskType, difficulty, createdAt, sessionFile };
		this.sessions.set(id, session);
		return session;
	}

	setProcess(sessionId: string, proc: ChildProcess | undefined) {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		s.process = proc;
	}
}
