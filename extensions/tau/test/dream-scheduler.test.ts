import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Cause, Effect, Exit, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DreamConfig } from "../src/dream/config.js";
import type { DreamRunRequest } from "../src/dream/domain.js";
import { DreamLock, type DreamLockInfo } from "../src/dream/lock.js";
import { DreamLockHeld } from "../src/dream/errors.js";
import { DreamScheduler, DreamSchedulerLive } from "../src/dream/scheduler.js";
import { dreamTranscriptRoot } from "../src/dream/transcripts.js";

const baseConfig: DreamConfig = {
	enabled: true,
	manual: { enabled: true },
	auto: {
		enabled: true,
		minHoursSinceLastRun: 0,
		minSessionsSinceLastRun: 1,
		scanThrottleMinutes: 10,
	},
	subagent: {
		model: "test/test-model",
		thinking: "medium",
		maxTurns: 4,
	},
};

const loadConfig = () => Effect.succeed(baseConfig);

function makeRequest(cwd: string): DreamRunRequest {
	return {
		cwd,
		mode: "auto",
		requestedBy: "scheduler",
	};
}

function makeLockLayer(inspect: (cwd: string) => Option.Option<DreamLockInfo>): Layer.Layer<DreamLock> {
	return Layer.succeed(
		DreamLock,
		DreamLock.of({
			acquire: () => Effect.die("unused"),
			acquireManual: () => Effect.die("unused"),
			releaseManual: () => Effect.void,
			inspect: (cwd) => Effect.succeed(inspect(cwd)),
		}),
	);
}

async function writeTranscript(cwd: string, sessionId: string): Promise<void> {
	const transcriptDir = dreamTranscriptRoot(cwd);
	await fs.mkdir(transcriptDir, { recursive: true });
	await fs.writeFile(path.join(transcriptDir, `1_${sessionId}.jsonl`), '{"type":"message"}\n', "utf8");
}

let tempDir = "";
let previousPiAgentDir: string | undefined;

describe("DreamScheduler", () => {
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-dream-scheduler-"));
		previousPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = path.join(tempDir, ".pi-agent");
	});

	afterEach(async () => {
		if (previousPiAgentDir === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = previousPiAgentDir;
		}

		if (tempDir.length > 0) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
		tempDir = "";
	});

	it("ignores a stale lock file when lock inspection reports no active holder", async () => {
		const cwd = path.join(tempDir, "workspace");
		await writeTranscript(cwd, "sess-1");
		await fs.mkdir(path.join(cwd, ".pi", "tau"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "tau", "dream.lock"), "stale", "utf8");

		const layer = DreamSchedulerLive({ loadConfig }).pipe(
			Layer.provide(makeLockLayer(() => Option.none())),
		);

		const permit = await Effect.runPromise(
			Effect.gen(function* () {
				const scheduler = yield* DreamScheduler;
				return yield* scheduler.evaluateAutoStart(makeRequest(cwd));
			}).pipe(Effect.provide(layer)),
		);

		expect(permit.sessions).toHaveLength(1);
		expect(permit.sessions[0]?.sessionId).toBe("sess-1");
	});

	it("does not consume the scan throttle window when auto-start is blocked by an active lock", async () => {
		const cwd = path.join(tempDir, "workspace");
		await writeTranscript(cwd, "sess-1");

		let inspectCallCount = 0;
		const layer = DreamSchedulerLive({ loadConfig }).pipe(
			Layer.provide(
				makeLockLayer((lockCwd) => {
					inspectCallCount += 1;
					if (inspectCallCount === 1) {
						return Option.some({
							path: path.join(lockCwd, ".pi", "tau", "dream.lock"),
							holderPid: 123,
						});
					}
					return Option.none();
				}),
			),
		);

		const firstExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const scheduler = yield* DreamScheduler;
				return yield* scheduler.evaluateAutoStart(makeRequest(cwd));
			}).pipe(Effect.provide(layer)),
		);

		expect(Exit.isFailure(firstExit)).toBe(true);
		if (Exit.isFailure(firstExit)) {
			const error = Cause.squash(firstExit.cause);
			expect(error).toBeInstanceOf(DreamLockHeld);
		}

		const permit = await Effect.runPromise(
			Effect.gen(function* () {
				const scheduler = yield* DreamScheduler;
				return yield* scheduler.evaluateAutoStart(makeRequest(cwd));
			}).pipe(Effect.provide(layer)),
		);

		expect(permit.sessions).toHaveLength(1);
		expect(permit.sessions[0]?.sessionId).toBe("sess-1");
	});
});
