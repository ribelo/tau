import { Effect, Layer } from "effect";

import { PiAPILive, PiAPI } from "./effect/pi.js";
import { PiLoggerLive } from "./effect/logger.js";
import { Sandbox, SandboxLive } from "./services/sandbox.js";
import { SandboxStateLive } from "./services/state.js";
import { Beads, BeadsLive } from "./services/beads.js";
import { Footer, FooterLive } from "./services/footer.js";
import { Persistence, PersistenceLive } from "./services/persistence.js";
import { Exa, ExaLive } from "./services/exa.js";
import { TerminalPrompt, TerminalPromptLive } from "./services/terminal-prompt.js";
import { WorkedFor, WorkedForLive } from "./services/worked-for.js";
import { Status, StatusLive } from "./services/status.js";
import { Commit, CommitLive } from "./services/commit.js";
import { Editor, EditorLive } from "./services/editor.js";
import { SkillMarker, SkillMarkerLive } from "./services/skill-marker.js";
// TODO: Agent service disabled due to TypeScript errors - fix and re-enable
// import { Agent, AgentLive } from "./services/agent.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MainLayer = Layer.mergeAll(
	SandboxLive,
	BeadsLive,
	FooterLive,
	ExaLive,
	TerminalPromptLive,
	WorkedForLive,
	StatusLive,
	CommitLive,
	EditorLive,
	SkillMarkerLive,
	// AgentLive,
).pipe(
	Layer.provideMerge(SandboxStateLive),
	Layer.provideMerge(PersistenceLive),
	Layer.provideMerge(PiLoggerLive),
);

export const runTau = (pi: ExtensionAPI) => {
	const program = Effect.gen(function* () {
		const persistence = yield* Persistence;
		const sandbox = yield* Sandbox;
		const beads = yield* Beads;
		const footer = yield* Footer;
		const exa = yield* Exa;
		const terminalPrompt = yield* TerminalPrompt;
		const workedFor = yield* WorkedFor;
		const status = yield* Status;
		const commit = yield* Commit;
		const editor = yield* Editor;
		const skillMarker = yield* SkillMarker;
		// const agent = yield* Agent;

		yield* Effect.all(
			[
				persistence.setup,
				sandbox.setup,
				beads.setup,
				footer.setup,
				exa.setup,
				terminalPrompt.setup,
				workedFor.setup,
				status.setup,
				commit.setup,
				editor.setup,
				skillMarker.setup,
				// agent.setup,
			],
			{
				concurrency: "unbounded",
			},
		);
	});

	const layer = MainLayer.pipe(Layer.provide(PiAPILive(pi)));

	return Effect.runFork(program.pipe(Effect.provide(layer)));
};
