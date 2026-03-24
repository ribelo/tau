import { Effect, Layer } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { PiAPILive } from "./effect/pi.js";
import { PiLoggerLive } from "./effect/logger.js";
import { Sandbox, SandboxLive } from "./services/sandbox.js";
import { SandboxStateLive } from "./services/state.js";
import { Beads, BeadsLive } from "./services/beads.js";
import { Footer, FooterLive } from "./services/footer.js";
import { PromptModes, PromptModesLive } from "./services/prompt-modes.js";
import { Persistence, PersistenceLive } from "./services/persistence.js";
import { LegacyStateLive } from "./services/legacy-state.js";
import { Exa, ExaLive } from "./services/exa.js";
import { TerminalPrompt, TerminalPromptLive } from "./services/terminal-prompt.js";
import { WorkedFor, WorkedForLive } from "./services/worked-for.js";
import { Status, StatusLive } from "./services/status.js";
import { Commit, CommitLive } from "./services/commit.js";
import { Editor, EditorLive } from "./services/editor.js";
import { SkillMarker, SkillMarkerLive } from "./services/skill-marker.js";
import { Agent, AgentLive } from "./services/agent.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PersistenceLayer = PersistenceLive;
const LegacyStateLayer = LegacyStateLive.pipe(Layer.provide(PersistenceLayer));
const SandboxLayer = SandboxLive.pipe(
	Layer.provide(SandboxStateLive),
	Layer.provide(PersistenceLayer),
);
const FooterLayer = FooterLive.pipe(
	Layer.provide(NodeFileSystem.layer),
	Layer.provide(PersistenceLayer),
	Layer.provide(SandboxLayer),
);
const PromptModesLayer = PromptModesLive.pipe(Layer.provide(PersistenceLayer));
const StatusLayer = StatusLive.pipe(Layer.provide(PersistenceLayer));
const BeadsLayer = BeadsLive.pipe(Layer.provide(LegacyStateLayer));
const TerminalPromptLayer = TerminalPromptLive.pipe(Layer.provide(LegacyStateLayer));
const WorkedForLayer = WorkedForLive.pipe(Layer.provide(LegacyStateLayer));
const EditorLayer = EditorLive.pipe(Layer.provide(LegacyStateLayer));
const SkillMarkerLayer = SkillMarkerLive.pipe(Layer.provide(LegacyStateLayer));

const MainLayer = Layer.mergeAll(
	PersistenceLayer,
	LegacyStateLayer,
	SandboxLayer,
	BeadsLayer,
	FooterLayer,
	PromptModesLayer,
	ExaLive,
	TerminalPromptLayer,
	WorkedForLayer,
	StatusLayer,
	CommitLive,
	EditorLayer,
	SkillMarkerLayer,
	AgentLive,
).pipe(Layer.provide(PiLoggerLive));

export const runTau = (pi: ExtensionAPI) => {
	const program = Effect.scoped(
		Effect.gen(function* () {
			const persistence = yield* Persistence;
			const sandbox = yield* Sandbox;
			const beads = yield* Beads;
			const footer = yield* Footer;
			const promptModes = yield* PromptModes;
			const exa = yield* Exa;
			const terminalPrompt = yield* TerminalPrompt;
			const workedFor = yield* WorkedFor;
			const status = yield* Status;
			const commit = yield* Commit;
			const editor = yield* Editor;
			const skillMarker = yield* SkillMarker;
			const agent = yield* Agent;

			yield* persistence.setup;
			yield* sandbox.setup;
			yield* beads.setup;
			yield* footer.setup;
			yield* promptModes.setup;
			yield* exa.setup;
			yield* terminalPrompt.setup;
			yield* workedFor.setup;
			yield* status.setup;
			yield* commit.setup;
			yield* editor.setup;
			yield* skillMarker.setup;
			yield* agent.setup;
		}),
	);

	const layer = MainLayer.pipe(Layer.provide(PiAPILive(pi)));
	return Effect.runFork(program.pipe(Effect.provide(layer)));
};
