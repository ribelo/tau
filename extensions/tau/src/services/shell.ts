import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import * as process from "node:process";

import { Context, Effect, Layer, Queue, Ref, Schema } from "effect";
import * as pty from "node-pty";

export class ShellExecutionError extends Schema.TaggedErrorClass<ShellExecutionError>()(
	"ShellExecutionError",
	{ reason: Schema.String },
) {}

export type ShellSpawnRequest = {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly tty: boolean;
	readonly ownerId: string;
	readonly yieldTimeMs: number;
	readonly maxOutputTokens: number;
	readonly abortSignal?: AbortSignal;
};

export type ShellWriteRequest = {
	readonly sessionId: number;
	readonly ownerId: string;
	readonly chars: string;
	readonly yieldTimeMs: number;
	readonly maxOutputTokens: number;
};

export type ShellRunResult = {
	readonly output: string;
	readonly sessionId?: number;
	readonly exitCode?: number;
};

type ManagedProcess =
	| {
			readonly kind: "pty";
			readonly process: pty.IPty;
			readonly write: (chars: string) => void;
			readonly kill: () => void;
	  }
	| {
			readonly kind: "pipe";
			readonly process: ChildProcessWithoutNullStreams;
			readonly write: (chars: string) => void;
			readonly kill: () => void;
	  };

type ShellSession = {
	readonly id: number;
	readonly ownerId: string;
	readonly notify: Queue.Queue<void>;
	managed: ManagedProcess | undefined;
	output: string;
	readOffset: number;
	exited: boolean;
	exitCode: number | undefined;
};

export type ShellService = {
	readonly exec: (request: ShellSpawnRequest) => Effect.Effect<ShellRunResult, ShellExecutionError>;
	readonly write: (request: ShellWriteRequest) => Effect.Effect<ShellRunResult, ShellExecutionError>;
	readonly shutdownOwner: (ownerId: string) => Effect.Effect<void>;
};

export class Shell extends Context.Service<Shell, ShellService>()("tau/services/Shell") {}

function killProcessTree(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Process already exited.
		}
	}
}

function normalizeYieldMs(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 1_000;
	return Math.min(Math.round(value), 600_000);
}

function maxCharsFromTokens(tokens: number): number {
	if (!Number.isFinite(tokens) || tokens <= 0) return 24_000;
	return Math.max(1_000, Math.min(Math.round(tokens * 4), 200_000));
}

function truncateOutput(output: string, maxOutputTokens: number): string {
	const maxChars = maxCharsFromTokens(maxOutputTokens);
	if (output.length <= maxChars) return output;
	const omitted = output.length - maxChars;
	return `[output truncated, omitted ${omitted} chars]\n${output.slice(-maxChars)}`;
}

function drainOutput(session: ShellSession, maxOutputTokens: number): string {
	const output = session.output.slice(session.readOffset);
	session.readOffset = session.output.length;
	return truncateOutput(output, maxOutputTokens);
}

const waitForSettle = Effect.fn("Shell.waitForSettle")(function* (
	session: ShellSession,
	yieldTimeMs: number,
) {
	const waitMs = normalizeYieldMs(yieldTimeMs);
	if (session.exited || waitMs === 0) return;
	const deadline = Date.now() + waitMs;
	while (!session.exited) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return;
		yield* Effect.race(
			Queue.take(session.notify),
			Effect.sleep(`${remaining} millis`),
		);
	}
});

function waitForAbort(signal: AbortSignal | undefined): Effect.Effect<never, ShellExecutionError> {
	if (!signal) return Effect.never;
	if (signal.aborted) {
		return Effect.fail(new ShellExecutionError({ reason: "Shell command aborted" }));
	}
	return Effect.callback<never, ShellExecutionError>((resume) => {
		const onAbort = () => {
			resume(Effect.fail(new ShellExecutionError({ reason: "Shell command aborted" })));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	});
}

function makeRunResult(
	session: ShellSession,
	output: string,
): ShellRunResult {
	if (session.exited) {
		return {
			output,
			exitCode: session.exitCode ?? 1,
		};
	}
	return {
		output,
		sessionId: session.id,
	};
}

function makePipeProcess(request: ShellSpawnRequest, session: ShellSession): ManagedProcess {
	if (!existsSync(request.cwd)) {
		throw new Error(`Working directory does not exist: ${request.cwd}`);
	}
	const child = spawn(request.file, [...request.args], {
		cwd: request.cwd,
		env: request.env,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});

	child.stdout.on("data", (data: Buffer) => {
		session.output += data.toString("utf8");
		Queue.offerUnsafe(session.notify, undefined);
	});
	child.stderr.on("data", (data: Buffer) => {
		session.output += data.toString("utf8");
		Queue.offerUnsafe(session.notify, undefined);
	});
	child.on("close", (code) => {
		session.exited = true;
		session.exitCode = code ?? 1;
		Queue.offerUnsafe(session.notify, undefined);
	});
	child.on("error", (error) => {
		session.output += `${error instanceof Error ? error.message : String(error)}\n`;
		session.exited = true;
		session.exitCode = 1;
		Queue.offerUnsafe(session.notify, undefined);
	});

	return {
		kind: "pipe",
		process: child,
		write: (chars) => {
			if (!child.stdin.destroyed) {
				child.stdin.write(chars);
			}
		},
		kill: () => {
			if (child.pid) killProcessTree(child.pid);
		},
	};
}

function makePtyProcess(request: ShellSpawnRequest, session: ShellSession): ManagedProcess {
	if (!existsSync(request.cwd)) {
		throw new Error(`Working directory does not exist: ${request.cwd}`);
	}
	const proc = pty.spawn(request.file, [...request.args], {
		cwd: request.cwd,
		env: request.env,
		name: "xterm-256color",
		cols: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
	});

	proc.onData((data) => {
		session.output += data;
		Queue.offerUnsafe(session.notify, undefined);
	});
	proc.onExit((event) => {
		session.exited = true;
		session.exitCode = event.exitCode;
		Queue.offerUnsafe(session.notify, undefined);
	});

	return {
		kind: "pty",
		process: proc,
		write: (chars) => proc.write(chars),
		kill: () => proc.kill(),
	};
}

export const ShellLive = Layer.effect(
	Shell,
	Effect.gen(function* () {
		const sessions = yield* Ref.make(new Map<number, ShellSession>());
		const nextId = yield* Ref.make(1);

		const deleteSession = (id: number) =>
			Ref.update(sessions, (current) => {
				const next = new Map(current);
				next.delete(id);
				return next;
			});

		const insertSession = (session: ShellSession) =>
			Ref.update(sessions, (current) => {
				const next = new Map(current);
				next.set(session.id, session);
				return next;
			});

		const shutdownSessions = Effect.fn("Shell.shutdownSessions")(function* (
			shouldShutdown: (session: ShellSession) => boolean,
		) {
			const current = yield* Ref.get(sessions);
			const selected = Array.from(current.values()).filter(shouldShutdown);
			for (const session of selected) {
				yield* Effect.sync(() => session.managed?.kill());
				yield* deleteSession(session.id);
			}
		});

		const exec: Shell["Service"]["exec"] = Effect.fn("Shell.exec")(function* (request) {
			const id = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
			const notify = yield* Queue.unbounded<void>();
			const session: ShellSession = {
				id,
				ownerId: request.ownerId,
				notify,
				managed: undefined,
				output: "",
				readOffset: 0,
				exited: false,
				exitCode: undefined,
			};

			yield* Effect.uninterruptible(Effect.gen(function* () {
				const managed = yield* Effect.try({
					try: () =>
						request.tty ? makePtyProcess(request, session) : makePipeProcess(request, session),
					catch: (cause) =>
						new ShellExecutionError({
							reason: cause instanceof Error ? cause.message : String(cause),
						}),
				});
				session.managed = managed;
				yield* insertSession(session);
			}));
			yield* Effect.raceFirst(
				waitForSettle(session, request.yieldTimeMs),
				waitForAbort(request.abortSignal),
			).pipe(
				Effect.catchTag(
					"ShellExecutionError",
					Effect.fn("Shell.exec.abortCleanup")(function* (error) {
						yield* shutdownSessions((current) => current.id === session.id);
						return yield* Effect.fail(error);
					}),
				),
			);
			const output = drainOutput(session, request.maxOutputTokens);
			if (session.exited) {
				yield* deleteSession(session.id);
			}
			return makeRunResult(session, output);
		});

		const write: Shell["Service"]["write"] = Effect.fn("Shell.write")(function* (request) {
			const current = yield* Ref.get(sessions);
			const session = current.get(request.sessionId);
			if (!session) {
				return yield* new ShellExecutionError({
					reason: `Unknown shell session: ${request.sessionId}`,
				});
			}
			if (session.ownerId !== request.ownerId) {
				return yield* new ShellExecutionError({
					reason: `Shell session ${request.sessionId} belongs to another pi session`,
				});
			}
			if (request.chars.length > 0 && !session.exited) {
				yield* Effect.try({
					try: () => session.managed?.write(request.chars),
					catch: (cause) =>
						new ShellExecutionError({
							reason: cause instanceof Error ? cause.message : String(cause),
						}),
				});
			}
			yield* waitForSettle(session, request.yieldTimeMs);
			const output = drainOutput(session, request.maxOutputTokens);
			if (session.exited) {
				yield* deleteSession(session.id);
			}
			return makeRunResult(session, output);
		});

		const shutdownOwner: Shell["Service"]["shutdownOwner"] = Effect.fn("Shell.shutdownOwner")(
			function* (ownerId) {
				yield* shutdownSessions((session) => session.ownerId === ownerId);
			},
		);

		yield* Effect.addFinalizer(() => shutdownSessions(() => true));

		return Shell.of({ exec, write, shutdownOwner });
	}),
);
