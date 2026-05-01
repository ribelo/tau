import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import initGoal from "../src/goal/index.js";
import { Goal, GoalLive } from "../src/services/goal.js";

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type SentMessage = {
	readonly message: {
		readonly customType: string;
		readonly content: unknown;
		readonly display: boolean;
		readonly details?: unknown;
	};
	readonly options?: {
		readonly triggerTurn?: boolean;
		readonly deliverAs?: "steer" | "followUp" | "nextTurn";
	};
};

type GoalAdapterHarness = {
	readonly commands: Map<string, RegisteredCommand>;
	readonly sentMessages: SentMessage[];
	readonly ctx: ExtensionCommandContext;
	readonly dispose: () => Promise<void>;
};

function makeGoalAdapterHarness(): GoalAdapterHarness {
	const commands = new Map<string, RegisteredCommand>();
	const sentMessages: SentMessage[] = [];
	const piBase = {
		on: () => undefined,
		registerTool: () => undefined,
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			sentMessages.push(options === undefined ? { message } : { message, options });
		},
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = ManagedRuntime.make(GoalLive.pipe(Layer.provide(PiAPILive(piBase))));
	initGoal(piBase, (effect) => runtime.runPromise(effect));

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [],
		},
		ui: {
			notify: () => undefined,
			confirm: async () => true,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;

	return {
		commands,
		sentMessages,
		ctx,
		dispose: () => runtime.dispose(),
	};
}

async function runGoalCommand(
	harness: GoalAdapterHarness,
	args: string,
	ctx: ExtensionCommandContext = harness.ctx,
): Promise<void> {
	const command = harness.commands.get("goal");
	if (command === undefined) {
		throw new Error("goal command was not registered");
	}
	await command.handler(args, ctx);
}

describe("goal adapter", () => {
	const harnesses: GoalAdapterHarness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
		}
	});

	it("starts an idle agent turn after setting a goal from /goal", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
		expect(harness.sentMessages[0]?.message.display).toBe(false);
		expect(harness.sentMessages[0]?.message.content).toContain("ship the feature");
		expect(harness.sentMessages[0]?.options).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("does not start a turn when the session is not idle", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const ctx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionCommandContext;

		await runGoalCommand(harness, "ship the feature", ctx);

		expect(harness.sentMessages).toHaveLength(0);
	});

	it("starts an idle agent turn after /goal resume", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await runGoalCommand(harness, "pause");
		await runGoalCommand(harness, "resume");

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
	});
});
