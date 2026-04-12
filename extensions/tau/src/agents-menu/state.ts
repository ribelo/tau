import * as fs from "node:fs";
import * as path from "node:path";

import { Option } from "effect";

import { findNearestWorkspaceRoot } from "../shared/discovery.js";
import { readJsonFile, writeJsonFile } from "../shared/fs.js";
import { isRecord, type AnyRecord } from "../shared/json.js";
import { LOOPS_STATE_DIR } from "../loops/paths.js";
import { decodeLoopPersistedStateJsonSync } from "../loops/schema.js";

type ProjectAgentState = {
	readonly disabledAgents: Set<string>;
	dirty: boolean;
};

const DEFAULT_RALPH_ENABLED_AGENTS = ["finder", "librarian"] as const;

function createProjectAgentState(disabledAgents: Iterable<string>, dirty: boolean): ProjectAgentState {
	return {
		disabledAgents: new Set(disabledAgents),
		dirty,
	};
}

function readEnabledAgentsFromSettings(
	settings: AnyRecord | null,
): ReadonlyArray<string> | undefined {
	if (settings === null) {
		return undefined;
	}

	const tau = settings["tau"];
	if (!isRecord(tau)) {
		return undefined;
	}

	const agents = tau["agents"];
	if (!isRecord(agents)) {
		return undefined;
	}

	const enabled = agents["enabled"];
	if (!Array.isArray(enabled)) {
		return undefined;
	}

	return enabled.filter((value): value is string => typeof value === "string");
}

function readRalphEnabledAgentsFromSettings(
	settings: AnyRecord | null,
): ReadonlyArray<string> | undefined {
	if (settings === null) {
		return undefined;
	}

	const tau = settings["tau"];
	if (!isRecord(tau)) {
		return undefined;
	}

	const ralph = tau["ralph"];
	if (!isRecord(ralph)) {
		return undefined;
	}

	const agents = ralph["agents"];
	if (!isRecord(agents)) {
		return undefined;
	}

	const enabled = agents["enabled"];
	if (!Array.isArray(enabled)) {
		return undefined;
	}

	return enabled.filter((value): value is string => typeof value === "string");
}

function buildStateFromEnabledAgents(
	availableAgents: ReadonlyArray<string>,
	enabledAgents: ReadonlyArray<string> | undefined,
): ProjectAgentState {
	if (enabledAgents === undefined) {
		return createProjectAgentState([], false);
	}

	const enabled = new Set(enabledAgents.filter((name) => availableAgents.includes(name)));
	return createProjectAgentState(
		availableAgents.filter((name) => !enabled.has(name)),
		false,
	);
}

function pruneStateToAvailableAgents(
	state: ProjectAgentState,
	availableAgents: ReadonlyArray<string>,
): ProjectAgentState {
	const available = new Set(availableAgents);
	return createProjectAgentState(
		Array.from(state.disabledAgents).filter((name) => available.has(name)),
		state.dirty,
	);
}

export function getAgentSettingsPath(cwd: string): string {
	return path.join(findNearestWorkspaceRoot(cwd), ".pi", "settings.json");
}

function getRalphStateDirectory(cwd: string): string {
	return path.join(findNearestWorkspaceRoot(cwd), LOOPS_STATE_DIR);
}

function stateOwnsSessionFile(
	sessionFile: string,
	state: ReturnType<typeof decodeLoopPersistedStateJsonSync>,
): boolean {
	if (state.kind !== "ralph") {
		return false;
	}
	if (state.lifecycle === "completed" || state.lifecycle === "archived") {
		return false;
	}

	const controllerMatches = Option.match(state.ownership.controller, {
		onNone: () => false,
		onSome: (controller) => controller.sessionFile === sessionFile,
	});
	if (controllerMatches) {
		return true;
	}

	return Option.match(state.ownership.child, {
		onNone: () => false,
		onSome: (child) => child.sessionFile === sessionFile,
	});
}

export function isRalphOwnedSession(cwd: string, sessionFile: string | undefined): boolean {
	if (sessionFile === undefined) {
		return false;
	}

	const stateDir = getRalphStateDirectory(cwd);
	if (!fs.existsSync(stateDir)) {
		return false;
	}

	let entries: ReadonlyArray<string>;
	try {
		entries = fs.readdirSync(stateDir);
	} catch {
		return false;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const filePath = path.join(stateDir, entry);
		try {
			const state = decodeLoopPersistedStateJsonSync(fs.readFileSync(filePath, "utf-8"));
			if (stateOwnsSessionFile(sessionFile, state)) {
				return true;
			}
		} catch {
			continue;
		}
	}

	return false;
}

function isDisabledByRalphPolicy(
	settings: AnyRecord | null,
	cwd: string,
	sessionFile: string | undefined,
	name: string,
): boolean {
	if (!isRalphOwnedSession(cwd, sessionFile)) {
		return false;
	}

	const enabledAgents = readRalphEnabledAgentsFromSettings(settings) ?? DEFAULT_RALPH_ENABLED_AGENTS;
	return !enabledAgents.includes(name);
}

export class AgentSelectionStore {
	private readonly states = new Map<string, ProjectAgentState>();

	activate(cwd: string, availableAgents: ReadonlyArray<string>): void {
		const settingsPath = getAgentSettingsPath(cwd);

		const existing = this.states.get(settingsPath);
		if (existing !== undefined && existing.dirty) {
			this.states.set(settingsPath, pruneStateToAvailableAgents(existing, availableAgents));
			return;
		}

		const settings = readJsonFile(settingsPath);
		const enabledAgents = readEnabledAgentsFromSettings(settings);
		this.states.set(settingsPath, buildStateFromEnabledAgents(availableAgents, enabledAgents));
	}

	isDisabledForCwd(cwd: string, name: string): boolean {
		const settingsPath = getAgentSettingsPath(cwd);
		const existing = this.states.get(settingsPath);
		if (existing !== undefined) {
			return existing.disabledAgents.has(name);
		}

		const enabledAgents = readEnabledAgentsFromSettings(readJsonFile(settingsPath));
		return enabledAgents === undefined ? false : !enabledAgents.includes(name);
	}

	isDisabledForSession(cwd: string, sessionFile: string | undefined, name: string): boolean {
		const settingsPath = getAgentSettingsPath(cwd);
		const settings = readJsonFile(settingsPath);
		return this.isDisabledForCwd(cwd, name) || isDisabledByRalphPolicy(settings, cwd, sessionFile, name);
	}

	setEnabledForCwd(cwd: string, name: string, enabled: boolean): void {
		const state = this.getStateForCwd(cwd);
		if (enabled) {
			state.disabledAgents.delete(name);
		} else {
			state.disabledAgents.add(name);
		}
		state.dirty = true;
	}

	isDirtyForCwd(cwd: string): boolean {
		return this.getStateForCwdOrUndefined(cwd)?.dirty ?? false;
	}

	persistForCwd(cwd: string, availableAgents: ReadonlyArray<string>): string {
		const settingsPath = getAgentSettingsPath(cwd);
		const current = readJsonFile(settingsPath) ?? {};
		const tau = isRecord(current["tau"]) ? { ...current["tau"] } : {};
		const agents = isRecord(tau["agents"]) ? { ...tau["agents"] } : {};
		const enabledAgents = availableAgents.filter((name) => !this.isDisabledForCwd(cwd, name));

		agents["enabled"] = enabledAgents;
		tau["agents"] = agents;

		const next: AnyRecord = {
			...current,
			tau,
		};
		writeJsonFile(settingsPath, next);

		const state = this.getStateForCwd(cwd);
		state.dirty = false;
		return settingsPath;
	}

	private getStateForCwd(cwd: string): ProjectAgentState {
		const state = this.getStateForCwdOrUndefined(cwd);
		if (state === undefined) {
			throw new Error(`No agent selection state for ${cwd}`);
		}
		return state;
	}

	private getStateForCwdOrUndefined(cwd: string): ProjectAgentState | undefined {
		return this.states.get(getAgentSettingsPath(cwd));
	}
}
