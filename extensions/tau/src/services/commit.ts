import { type Effect, ServiceMap } from "effect";

import initCommitLegacy from "../commit/index.js";
import { legacyPiLayer } from "./legacy.js";

export interface Commit {
	readonly setup: Effect.Effect<void>;
}

export const Commit = ServiceMap.Service<Commit>("Commit");

export const CommitLive = legacyPiLayer(Commit, (pi) => initCommitLegacy(pi));
