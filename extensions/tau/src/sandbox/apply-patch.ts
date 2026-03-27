import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";

import { getWorkerApprovalBroker } from "../agent/approval-broker.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/json.js";
import { loadPersistedState } from "../shared/state.js";
import type { SandboxConfig } from "./config.js";
import { computeEffectiveConfig } from "./config.js";
import { checkFilesystemApproval } from "./approval.js";
import { checkWriteAllowed } from "./fs-policy.js";
import { APPLY_PATCH_TOOL_NAME } from "./mutation-tools.js";
import { discoverWorkspaceRoot } from "./workspace-root.js";

const FILE_MUTATION_QUEUE_KEY = Symbol.for("@mariozechner/pi-coding-agent:file-mutation-queues");

const _global = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
const fileMutationQueues: Map<string, Promise<void>> =
	_global[FILE_MUTATION_QUEUE_KEY] ??
	(_global[FILE_MUTATION_QUEUE_KEY] = new Map<string, Promise<void>>());

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = await getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolve) => {
		releaseNext = resolve;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

const ApplyPatchParams = Type.Object({
	input: Type.String({
		description:
			"The full Codex apply_patch body, including *** Begin Patch / *** End Patch markers.",
	}),
});

type ParsePatchResult = {
	readonly patch: string;
	readonly hunks: readonly PatchHunk[];
};

type AddFileHunk = {
	readonly type: "add";
	readonly path: string;
	readonly contents: string;
};

type DeleteFileHunk = {
	readonly type: "delete";
	readonly path: string;
};

type UpdateFileChunk = {
	readonly changeContext?: string | undefined;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
	readonly isEndOfFile: boolean;
};

type UpdateFileHunk = {
	readonly type: "update";
	readonly path: string;
	readonly movePath?: string | undefined;
	readonly chunks: readonly UpdateFileChunk[];
};

type PatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type ResolvedAddOperation = {
	readonly type: "add";
	readonly absolutePath: string;
	readonly contents: string;
};

type ResolvedDeleteOperation = {
	readonly type: "delete";
	readonly absolutePath: string;
};

type ResolvedUpdateOperation = {
	readonly type: "update";
	readonly absolutePath: string;
	readonly movePath?: string | undefined;
	readonly chunks: readonly UpdateFileChunk[];
};

type ResolvedPatchOperation =
	| ResolvedAddOperation
	| ResolvedDeleteOperation
	| ResolvedUpdateOperation;

type FileDiff = {
	readonly filePath: string;
	readonly diff: string;
};

type ApplyPatchSummary = {
	readonly added: readonly string[];
	readonly modified: readonly string[];
	readonly deleted: readonly string[];
	readonly diffs: readonly FileDiff[];
};

type SessionSandboxContext = {
	readonly workspaceRoot: string;
	readonly effectiveConfig: ReturnType<typeof computeEffectiveConfig>;
};

type ApplyPatchToolOptions = {
	readonly resolveSessionSandboxContext?:
		| ((ctx: ExtensionContext) => SessionSandboxContext)
		| undefined;
};

function readSessionOverride(value: unknown): SandboxConfig | undefined {
	if (!isRecord(value)) return undefined;

	const next: SandboxConfig = {};
	const preset = value["preset"];
	if (preset === "read-only" || preset === "workspace-write" || preset === "full-access") {
		next.preset = preset;
	}

	const subagent = value["subagent"];
	if (typeof subagent === "boolean") {
		next.subagent = subagent;
	}

	return next;
}

function resolveDefaultSessionSandboxContext(ctx: {
	readonly cwd: string;
	readonly sessionManager: { readonly getEntries: () => unknown[] };
}): SessionSandboxContext {
	const persisted = loadPersistedState(ctx);
	const workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
	const sessionOverride = readSessionOverride(persisted.sandbox?.["sessionOverride"]);
	const effectiveConfig = computeEffectiveConfig({
		workspaceRoot,
		...(sessionOverride ? { sessionOverride } : {}),
	});
	return { workspaceRoot, effectiveConfig };
}

function normalizePatchPath(rawPath: string, lineNumber: number): string {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		throw new Error(`Invalid patch hunk at line ${lineNumber}: file path must not be empty`);
	}
	if (path.isAbsolute(trimmed)) {
		throw new Error(
			`Invalid patch hunk at line ${lineNumber}: file paths must be relative, got "${trimmed}"`,
		);
	}
	return trimmed;
}

function splitPatchLines(patch: string): string[] {
	return patch.split(/\r?\n/);
}

function checkPatchBoundariesLenient(lines: readonly string[]): readonly string[] {
	const firstLine = lines[0];
	const lastLine = lines[lines.length - 1];
	if (
		(firstLine === "<<EOF" || firstLine === "<<'EOF'" || firstLine === '<<"EOF"') &&
		typeof lastLine === "string" &&
		lastLine.endsWith("EOF") &&
		lines.length >= 4
	) {
		return lines.slice(1, -1);
	}
	return lines;
}

function normalizePatchBoundaries(patch: string): readonly string[] {
	const initialLines = splitPatchLines(patch.trim());
	const lines = checkPatchBoundariesLenient(initialLines);
	const firstLine = lines[0]?.trim();
	const lastLine = lines[lines.length - 1]?.trim();
	if (firstLine !== BEGIN_PATCH_MARKER) {
		throw new Error(`Invalid patch: first line must be '${BEGIN_PATCH_MARKER}'`);
	}
	if (lastLine !== END_PATCH_MARKER) {
		throw new Error(`Invalid patch: last line must be '${END_PATCH_MARKER}'`);
	}
	return lines;
}

function parsePatch(input: string): ParsePatchResult {
	const lines = normalizePatchBoundaries(input);
	const hunks: PatchHunk[] = [];
	let index = 1;
	let lineNumber = 2;
	const lastContentIndex = Math.max(1, lines.length - 1);

	while (index < lastContentIndex) {
		const line = lines[index];
		if (line === undefined) break;
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			index += 1;
			lineNumber += 1;
			continue;
		}

		const parsed = parseOneHunk(lines, index, lineNumber);
		hunks.push(parsed.hunk);
		index += parsed.linesConsumed;
		lineNumber += parsed.linesConsumed;
	}

	return {
		patch: lines.join("\n"),
		hunks,
	};
}

function parseOneHunk(
	lines: readonly string[],
	startIndex: number,
	lineNumber: number,
): { readonly hunk: PatchHunk; readonly linesConsumed: number } {
	const firstLine = lines[startIndex]?.trim();
	if (firstLine === undefined) {
		throw new Error(`Invalid patch hunk at line ${lineNumber}: missing hunk header`);
	}

	const addPath = firstLine.startsWith(ADD_FILE_MARKER)
		? normalizePatchPath(firstLine.slice(ADD_FILE_MARKER.length), lineNumber)
		: undefined;
	if (addPath !== undefined) {
		let contents = "";
		let consumed = 1;
		for (let index = startIndex + 1; index < lines.length; index += 1) {
			const candidate = lines[index];
			if (candidate !== undefined && candidate.startsWith("+")) {
				contents += candidate.slice(1);
				contents += "\n";
				consumed += 1;
				continue;
			}
			break;
		}
		if (contents.length === 0) {
			throw new Error(`Invalid patch hunk at line ${lineNumber}: add file hunk is empty`);
		}
		return {
			hunk: { type: "add", path: addPath, contents },
			linesConsumed: consumed,
		};
	}

	const deletePath = firstLine.startsWith(DELETE_FILE_MARKER)
		? normalizePatchPath(firstLine.slice(DELETE_FILE_MARKER.length), lineNumber)
		: undefined;
	if (deletePath !== undefined) {
		return {
			hunk: { type: "delete", path: deletePath },
			linesConsumed: 1,
		};
	}

	const updatePath = firstLine.startsWith(UPDATE_FILE_MARKER)
		? normalizePatchPath(firstLine.slice(UPDATE_FILE_MARKER.length), lineNumber)
		: undefined;
	if (updatePath !== undefined) {
		let cursor = startIndex + 1;
		let consumed = 1;
		let movePath: string | undefined;

		const maybeMoveLine = lines[cursor];
		if (typeof maybeMoveLine === "string" && maybeMoveLine.startsWith(MOVE_TO_MARKER)) {
			movePath = normalizePatchPath(maybeMoveLine.slice(MOVE_TO_MARKER.length), lineNumber + 1);
			cursor += 1;
			consumed += 1;
		}

		const chunks: UpdateFileChunk[] = [];
		while (cursor < lines.length) {
			const currentLine = lines[cursor];
			if (currentLine === undefined) break;
			if (currentLine.trim().length === 0) {
				cursor += 1;
				consumed += 1;
				continue;
			}
			if (currentLine.startsWith("***")) {
				break;
			}
			const parsedChunk = parseUpdateFileChunk(
				lines,
				cursor,
				lineNumber + consumed,
				chunks.length === 0,
			);
			chunks.push(parsedChunk.chunk);
			cursor += parsedChunk.linesConsumed;
			consumed += parsedChunk.linesConsumed;
		}

		if (chunks.length === 0) {
			throw new Error(
				`Invalid patch hunk at line ${lineNumber}: update file hunk for path '${updatePath}' is empty`,
			);
		}

		return {
			hunk: { type: "update", path: updatePath, movePath, chunks },
			linesConsumed: consumed,
		};
	}

	throw new Error(
		`Invalid patch hunk at line ${lineNumber}: '${firstLine}' is not a valid hunk header`,
	);
}

function parseUpdateFileChunk(
	lines: readonly string[],
	startIndex: number,
	lineNumber: number,
	allowMissingContext: boolean,
): { readonly chunk: UpdateFileChunk; readonly linesConsumed: number } {
	const firstLine = lines[startIndex];
	if (firstLine === undefined) {
		throw new Error(`Invalid patch hunk at line ${lineNumber}: update hunk is empty`);
	}

	let changeContext: string | undefined;
	let cursor = startIndex;
	if (firstLine === EMPTY_CHANGE_CONTEXT_MARKER) {
		cursor += 1;
	} else if (firstLine.startsWith(CHANGE_CONTEXT_MARKER)) {
		changeContext = firstLine.slice(CHANGE_CONTEXT_MARKER.length);
		cursor += 1;
	} else if (!allowMissingContext) {
		throw new Error(
			`Invalid patch hunk at line ${lineNumber}: expected update hunk to start with @@`,
		);
	}

	if (cursor >= lines.length) {
		throw new Error(`Invalid patch hunk at line ${lineNumber}: update hunk is empty`);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let isEndOfFile = false;
	let parsedLines = 0;

	for (let index = cursor; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) break;
		if (line === EOF_MARKER) {
			if (parsedLines === 0) {
				throw new Error(`Invalid patch hunk at line ${lineNumber}: update hunk is empty`);
			}
			isEndOfFile = true;
			parsedLines += 1;
			break;
		}

		const prefix = line[0];
		if (prefix === " ") {
			oldLines.push(line.slice(1));
			newLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}
		if (prefix === "+") {
			newLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}
		if (prefix === "-") {
			oldLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}
		if (line.length === 0) {
			oldLines.push("");
			newLines.push("");
			parsedLines += 1;
			continue;
		}
		if (parsedLines === 0) {
			throw new Error(
				`Invalid patch hunk at line ${lineNumber}: unexpected line '${line}' in update hunk`,
			);
		}
		break;
	}

	if (parsedLines === 0) {
		throw new Error(`Invalid patch hunk at line ${lineNumber}: update hunk is empty`);
	}

	return {
		chunk: {
			...(changeContext !== undefined ? { changeContext } : {}),
			oldLines,
			newLines,
			isEndOfFile,
		},
		linesConsumed: parsedLines + (cursor - startIndex),
	};
}

function seekSequence(
	lines: readonly string[],
	pattern: readonly string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) {
		return start;
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const maxStart = lines.length - pattern.length;

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (lines[index + offset] !== pattern[offset]) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (lines[index + offset]?.trimEnd() !== pattern[offset]?.trimEnd()) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (lines[index + offset]?.trim() !== pattern[offset]?.trim()) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	const normalizeLoose = (value: string): string =>
		value
			.trim()
			.replace(/[‐‑‒–—―−]/gu, "-")
			.replace(/[‘’‚‛]/gu, "'")
			.replace(/[“”„‟]/gu, '"')
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (normalizeLoose(lines[index + offset] ?? "") !== normalizeLoose(pattern[offset] ?? "")) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	return undefined;
}

type Replacement = {
	readonly startIndex: number;
	readonly oldLength: number;
	readonly newSegment: readonly string[];
};

function computeReplacements(
	originalLines: readonly string[],
	absolutePath: string,
	chunks: readonly UpdateFileChunk[],
): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (contextIndex === undefined) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${absolutePath}`);
			}
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push({
				startIndex: lineIndex,
				oldLength: 0,
				newSegment: chunk.newLines,
			});
			continue;
		}

		let searchPattern = [...chunk.oldLines];
		let newSegment = [...chunk.newLines];
		let foundIndex = seekSequence(originalLines, searchPattern, lineIndex, chunk.isEndOfFile);
		if (foundIndex === undefined && searchPattern[searchPattern.length - 1] === "") {
			searchPattern = searchPattern.slice(0, -1);
			if (newSegment[newSegment.length - 1] === "") {
				newSegment = newSegment.slice(0, -1);
			}
			foundIndex = seekSequence(originalLines, searchPattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundIndex === undefined) {
			throw new Error(
				`Failed to find expected lines in ${absolutePath}:\n${chunk.oldLines.join("\n")}`,
			);
		}

		replacements.push({
			startIndex: foundIndex,
			oldLength: searchPattern.length,
			newSegment,
		});
		lineIndex = foundIndex + searchPattern.length;
	}

	return [...replacements].sort((left, right) => left.startIndex - right.startIndex);
}

function applyReplacements(
	originalLines: readonly string[],
	replacements: readonly Replacement[],
): string[] {
	const nextLines = [...originalLines];
	for (const replacement of [...replacements].reverse()) {
		nextLines.splice(
			replacement.startIndex,
			replacement.oldLength,
			...replacement.newSegment,
		);
	}
	return nextLines;
}

async function deriveUpdatedFileContents(
	absolutePath: string,
	chunks: readonly UpdateFileChunk[],
): Promise<string> {
	const originalContents = await readFile(absolutePath, "utf8");
	const originalLines = originalContents.split("\n");
	if (originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}
	const replacements = computeReplacements(originalLines, absolutePath, chunks);
	const nextLines = applyReplacements(originalLines, replacements);
	if (nextLines[nextLines.length - 1] !== "") {
		nextLines.push("");
	}
	return nextLines.join("\n");
}

function resolveOperations(cwd: string, hunks: readonly PatchHunk[]): ResolvedPatchOperation[] {
	return hunks.map((hunk) => {
		const absolutePath = path.resolve(cwd, hunk.path);
		if (hunk.type === "add") {
			return {
				type: "add",
				absolutePath,
				contents: hunk.contents,
			} satisfies ResolvedAddOperation;
		}
		if (hunk.type === "delete") {
			return {
				type: "delete",
				absolutePath,
			} satisfies ResolvedDeleteOperation;
		}
		return {
			type: "update",
			absolutePath,
			...(hunk.movePath !== undefined
				? { movePath: path.resolve(cwd, hunk.movePath) }
				: {}),
			chunks: hunk.chunks,
		} satisfies ResolvedUpdateOperation;
	});
}

function collectMutationPaths(operations: readonly ResolvedPatchOperation[]): string[] {
	const unique = new Set<string>();
	for (const operation of operations) {
		unique.add(operation.absolutePath);
		if (operation.type === "update" && operation.movePath !== undefined) {
			unique.add(operation.movePath);
		}
	}
	return [...unique].sort();
}

async function ensureFilesystemAccess(
	ctx: ExtensionContext,
	sandboxContext: SessionSandboxContext,
	paths: readonly string[],
): Promise<void> {
	for (const targetPath of paths) {
		const check = checkWriteAllowed({
			targetPath,
			workspaceRoot: sandboxContext.workspaceRoot,
			filesystemMode: sandboxContext.effectiveConfig.filesystemMode,
		});
		if (check.allowed) {
			continue;
		}

		const approval = await checkFilesystemApproval(
			ctx,
			sandboxContext.effectiveConfig.approvalPolicy,
			targetPath,
			APPLY_PATCH_TOOL_NAME,
			{ timeoutSeconds: sandboxContext.effectiveConfig.approvalTimeoutSeconds },
			getWorkerApprovalBroker(ctx.sessionManager.getSessionId()),
		);
		if (!approval.approved) {
			throw new Error(`${check.reason} (${approval.reason})`);
		}
		ctx.ui.notify?.(`Approved: ${APPLY_PATCH_TOOL_NAME} ${targetPath}`, "info");
	}
}

async function withMutationQueues<A>(
	paths: readonly string[],
	effect: () => Promise<A>,
): Promise<A> {
	const sortedPaths = [...new Set(paths)].sort();
	const run = async (index: number): Promise<A> => {
		const targetPath = sortedPaths[index];
		if (targetPath === undefined) {
			return effect();
		}
		return withFileMutationQueue(targetPath, async () => run(index + 1));
	};
	return run(0);
}

async function applyResolvedPatch(
	operations: readonly ResolvedPatchOperation[],
	cwd: string,
): Promise<ApplyPatchSummary> {
	if (operations.length === 0) {
		throw new Error("No files were modified.");
	}

	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	const diffs: FileDiff[] = [];

	await withMutationQueues(collectMutationPaths(operations), async () => {
		for (const operation of operations) {
			if (operation.type === "add") {
				const exists = await access(operation.absolutePath).then(() => true, () => false);
				if (exists) {
					throw new Error(
						`Cannot add file ${path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath)}: file already exists`,
					);
				}
				await mkdir(path.dirname(operation.absolutePath), { recursive: true });
				await writeFile(operation.absolutePath, operation.contents, "utf8");
				const relPath = path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath);
				added.push(relPath);
				diffs.push({ filePath: relPath, diff: generateDiffString("", operation.contents) });
				continue;
			}

			if (operation.type === "delete") {
				const oldContents = await readFile(operation.absolutePath, "utf8").catch(() => "");
				await rm(operation.absolutePath);
				const relPath = path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath);
				deleted.push(relPath);
				diffs.push({ filePath: relPath, diff: generateDiffString(oldContents, "") });
				continue;
			}

			const oldContents = await readFile(operation.absolutePath, "utf8");
			const nextContents = await deriveUpdatedFileContents(operation.absolutePath, operation.chunks);
			if (operation.movePath !== undefined) {
				await mkdir(path.dirname(operation.movePath), { recursive: true });
				await writeFile(operation.movePath, nextContents, "utf8");
				await rm(operation.absolutePath);
				const relPath = path.relative(cwd, operation.movePath) || path.basename(operation.movePath);
				modified.push(relPath);
				diffs.push({ filePath: relPath, diff: generateDiffString(oldContents, nextContents) });
				continue;
			}

			await writeFile(operation.absolutePath, nextContents, "utf8");
			const relPath = path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath);
			modified.push(relPath);
			diffs.push({ filePath: relPath, diff: generateDiffString(oldContents, nextContents) });
		}
	});

	return { added, modified, deleted, diffs };
}

function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum++;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange =
				i < parts.length - 1 &&
				(parts[i + 1]?.added === true || parts[i + 1]?.removed === true);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

function formatSummary(summary: ApplyPatchSummary): string {
	const lines = ["Success. Updated the following files:"];
	for (const filePath of summary.added) {
		lines.push(`A ${filePath}`);
	}
	for (const filePath of summary.modified) {
		lines.push(`M ${filePath}`);
	}
	for (const filePath of summary.deleted) {
		lines.push(`D ${filePath}`);
	}
	return lines.join("\n");
}

const APPLY_PATCH_DESCRIPTION = [
	"Apply a Codex-style patch to the filesystem.",
	"Provide the full patch in the input string using this format:",
	"*** Begin Patch",
	"*** Add File: path/to/file",
	"+new line",
	"*** Update File: path/to/existing",
	"@@ optional context",
	"-old line",
	"+new line",
	"*** Delete File: path/to/remove",
	"*** End Patch",
	"Use relative paths only.",
].join("\n");

type DiffTheme = {
	fg: (color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string) => string;
	inverse: (text: string) => string;
};

function renderColoredDiff(diffText: string, theme: DiffTheme): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i++;
			continue;
		}
		const prefix = line[0];

		if (prefix === "-") {
			const removedLines: string[] = [];
			while (i < lines.length && lines[i]?.[0] === "-") {
				removedLines.push(lines[i] ?? "");
				i++;
			}
			const addedLines: string[] = [];
			while (i < lines.length && lines[i]?.[0] === "+") {
				addedLines.push(lines[i] ?? "");
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removedContent = (removedLines[0] ?? "").replace(/^-\s*\d*\s/, "");
				const addedContent = (addedLines[0] ?? "").replace(/^\+\s*\d*\s/, "");
				const wordDiff = Diff.diffWords(removedContent, addedContent);
				let removedRendered = (removedLines[0] ?? "").replace(removedContent, "");
				let addedRendered = (addedLines[0] ?? "").replace(addedContent, "");
				for (const part of wordDiff) {
					if (part.removed) {
						removedRendered += theme.inverse(part.value);
					} else if (part.added) {
						addedRendered += theme.inverse(part.value);
					} else {
						removedRendered += part.value;
						addedRendered += part.value;
					}
				}
				result.push(theme.fg("toolDiffRemoved", removedRendered));
				result.push(theme.fg("toolDiffAdded", addedRendered));
			} else {
				for (const line of removedLines) {
					result.push(theme.fg("toolDiffRemoved", line));
				}
				for (const line of addedLines) {
					result.push(theme.fg("toolDiffAdded", line));
				}
			}
		} else if (prefix === "+") {
			result.push(theme.fg("toolDiffAdded", line));
			i++;
		} else {
			result.push(theme.fg("toolDiffContext", line));
			i++;
		}
	}

	return result.join("\n");
}

export function createApplyPatchToolDefinition(
	options?: ApplyPatchToolOptions,
): ToolDefinition {
	return {
		name: APPLY_PATCH_TOOL_NAME,
		label: APPLY_PATCH_TOOL_NAME,
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: "Apply Codex-style multi-file patches for file mutations",
		promptGuidelines: [
			"For openai and openai-codex models, use apply_patch instead of edit or write for filesystem changes.",
			"Pass the entire Codex patch body in the input string, including *** Begin Patch and *** End Patch.",
		],
		parameters: ApplyPatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = isRecord(params) ? params["input"] : undefined;
			if (typeof input !== "string") {
				throw new Error("apply_patch requires a string input field");
			}

			try {
				const sandboxContext = options?.resolveSessionSandboxContext
					? options.resolveSessionSandboxContext(ctx)
					: resolveDefaultSessionSandboxContext(ctx);
				const parsed = parsePatch(input);
				const operations = resolveOperations(ctx.cwd, parsed.hunks);
				await ensureFilesystemAccess(ctx, sandboxContext, collectMutationPaths(operations));
				const summary = await applyResolvedPatch(operations, ctx.cwd);
				return {
					content: [{ type: "text" as const, text: formatSummary(summary) }],
					details: summary,
				};
			} catch (error) {
				throw new Error(errorMessage(error));
			}
		},
		renderResult(result, _options, theme) {
			const summary = (result as { details?: ApplyPatchSummary }).details;
			if (!summary?.diffs?.length) {
				return new Text("", 0, 0);
			}
			const parts: string[] = [];
			for (const fileDiff of summary.diffs) {
				if (fileDiff.diff) {
					const header = theme.fg("toolTitle", fileDiff.filePath);
					parts.push(`${header}\n${renderColoredDiff(fileDiff.diff, theme)}`);
				}
			}
			return new Text(parts.length > 0 ? `\n${parts.join("\n\n")}` : "", 0, 0);
		},
	};
}

export const __test__ = {
	parsePatch,
	seekSequence,
	rewriteInputToOperations: (cwd: string, input: string): readonly ResolvedPatchOperation[] =>
		resolveOperations(cwd, parsePatch(input).hunks),
	applyResolvedPatch,
	formatSummary,
};
