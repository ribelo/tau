import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { Schema } from "effect";

import {
	BacklogIssueCreatedEventSchema,
	BacklogIssueUpdatedEventSchema,
	resolveBacklogPaths,
	type BacklogEvent,
} from "./contract.js";
import {
	assertBacklogEventCanBeApplied,
	rebuildBacklogCacheUnlocked,
	readBacklogEventsFromWorkspaceUnlocked,
	withBacklogWriteLock,
} from "./materialize.js";
import {
	decodeIssue,
	encodeIssue,
	type Comment,
	type Dependency,
	type Issue,
	type IssueStatus,
} from "./schema.js";
import { generateIssueId } from "./id.js";
import {
	importBeadsIfNeededUnlocked,
	writeEventFile,
} from "./storage.js";

export class BacklogIssueNotFoundError extends Error {
	constructor(issueId: string) {
		super(`Issue not found: ${issueId}`);
		this.name = "BacklogIssueNotFoundError";
	}
}

type CreateIssueInput = {
	readonly title: string;
	readonly actor: string;
	readonly id?: string;
	readonly prefix?: string;
	readonly recorded_at?: string;
	readonly fields?: Readonly<Record<string, unknown>>;
};

type UpdateIssueInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly recorded_at?: string;
	readonly setFields: Readonly<Record<string, unknown>>;
	readonly unsetFields?: ReadonlyArray<string>;
};

type StatusUpdateInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly status: IssueStatus;
	readonly reason?: string;
	readonly recorded_at?: string;
};

type DependencyMutationInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly dependsOnId: string;
	readonly type: string;
	readonly recorded_at?: string;
};

type RemoveDependencyInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly dependsOnId: string;
	readonly type?: string;
	readonly recorded_at?: string;
};

type AddCommentInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly text: string;
	readonly recorded_at?: string;
};

const decodeCreatedEvent = Schema.decodeUnknownSync(BacklogIssueCreatedEventSchema);
const decodeUpdatedEvent = Schema.decodeUnknownSync(BacklogIssueUpdatedEventSchema);

function nowIso(): string {
	return new Date().toISOString();
}

async function invalidateBacklogCache(workspaceRoot: string): Promise<void> {
	const paths = resolveBacklogPaths(workspaceRoot);
	await fs.rm(paths.materializedIssuesPath, { force: true });
}

async function appendEventUnlocked(workspaceRoot: string, event: BacklogEvent): Promise<ReadonlyArray<Issue>> {
	const existingEvents = await readBacklogEventsFromWorkspaceUnlocked(workspaceRoot);
	assertBacklogEventCanBeApplied(existingEvents, event);
	await writeEventFile(workspaceRoot, event);
	await invalidateBacklogCache(workspaceRoot);
	return rebuildBacklogCacheUnlocked(workspaceRoot);
}

export async function importBeadsIfNeeded(workspaceRoot: string): Promise<ReadonlyArray<Issue>> {
	return withBacklogWriteLock(workspaceRoot, () => importBeadsIfNeededUnlocked(workspaceRoot));
}

async function loadCurrentIssuesUnlocked(workspaceRoot: string): Promise<ReadonlyArray<Issue>> {
	await importBeadsIfNeededUnlocked(workspaceRoot);
	return rebuildBacklogCacheUnlocked(workspaceRoot);
}

function requireIssue(issues: ReadonlyArray<Issue>, issueId: string): Issue {
	const issue = issues.find((candidate) => candidate.id === issueId);
	if (!issue) {
		throw new BacklogIssueNotFoundError(issueId);
	}
	return issue;
}

function uniqueLabels(labels: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined {
	return labels ? [...new Set(labels)] : undefined;
}

export async function createIssue(workspaceRoot: string, input: CreateIssueInput): Promise<Issue> {
	return withBacklogWriteLock(workspaceRoot, async () => {
		const currentIssues = await loadCurrentIssuesUnlocked(workspaceRoot);
		const existingIds = new Set(currentIssues.map((issue) => issue.id));
		if (!input.id && !input.prefix) {
			throw new Error("createIssue requires either an explicit id or a prefix for id generation");
		}
		const issueId =
			input.id ??
			generateIssueId({
				prefix: input.prefix!,
				title: input.title,
				description: typeof input.fields?.["description"] === "string" ? input.fields["description"] : "",
				creator: input.actor,
				timestamp: new Date(input.recorded_at ?? nowIso()),
				existingIds,
				existingTopLevelCount: currentIssues.filter((issue) => !issue.id.includes(".")).length,
			});

		const recordedAt = input.recorded_at ?? nowIso();
		const candidate = decodeIssue({
			id: issueId,
			title: input.title,
			status: "open",
			priority: 2,
			issue_type: "task",
			created_at: recordedAt,
			created_by: input.actor,
			updated_at: recordedAt,
			...input.fields,
		});
		const event = decodeCreatedEvent({
			schema_version: 1,
			event_id: `create-${randomUUID()}`,
			issue_id: issueId,
			recorded_at: recordedAt,
			actor: input.actor,
			kind: "issue.created",
			fields: encodeIssue(candidate),
		});
		const issues = await appendEventUnlocked(workspaceRoot, event);
		return requireIssue(issues, issueId);
	});
}

async function updateIssueUnlocked(workspaceRoot: string, input: UpdateIssueInput): Promise<Issue> {
	const issues = await loadCurrentIssuesUnlocked(workspaceRoot);
	requireIssue(issues, input.issueId);
	const event = decodeUpdatedEvent({
		schema_version: 1,
		event_id: `update-${randomUUID()}`,
		issue_id: input.issueId,
		recorded_at: input.recorded_at ?? nowIso(),
		actor: input.actor,
		kind: "issue.updated",
		set_fields: input.setFields,
		unset_fields: [...(input.unsetFields ?? [])],
	});
	const nextIssues = await appendEventUnlocked(workspaceRoot, event);
	return requireIssue(nextIssues, input.issueId);
}

export async function updateIssue(workspaceRoot: string, input: UpdateIssueInput): Promise<Issue> {
	return withBacklogWriteLock(workspaceRoot, () => updateIssueUnlocked(workspaceRoot, input));
}

export async function setIssueStatus(workspaceRoot: string, input: StatusUpdateInput): Promise<Issue> {
	const recordedAt = input.recorded_at ?? nowIso();
	const setFields: Record<string, unknown> = {
		status: input.status,
		updated_at: recordedAt,
	};
	const unsetFields: string[] = [];
	if (input.status === "closed" || input.status === "tombstone") {
		setFields["closed_at"] = recordedAt;
		if (input.reason !== undefined) {
			setFields["close_reason"] = input.reason;
		}
	} else {
		unsetFields.push("closed_at", "close_reason");
	}

	return updateIssue(workspaceRoot, {
		issueId: input.issueId,
		actor: input.actor,
		recorded_at: recordedAt,
		setFields,
		unsetFields,
	});
}

export async function addIssueDependency(
	workspaceRoot: string,
	input: DependencyMutationInput,
): Promise<Issue> {
	return withBacklogWriteLock(workspaceRoot, async () => {
		const issues = await loadCurrentIssuesUnlocked(workspaceRoot);
		const issue = requireIssue(issues, input.issueId);
		requireIssue(issues, input.dependsOnId);
		const recordedAt = input.recorded_at ?? nowIso();
		const dependency: Dependency = {
			issue_id: input.issueId,
			depends_on_id: input.dependsOnId,
			type: input.type,
			created_at: recordedAt,
			created_by: input.actor,
		};
		const dependencies = [...(issue.dependencies ?? [])];
		if (!dependencies.some((entry) => entry.depends_on_id === dependency.depends_on_id && entry.type === dependency.type)) {
			dependencies.push(dependency);
		}
		return updateIssueUnlocked(workspaceRoot, {
			issueId: input.issueId,
			actor: input.actor,
			recorded_at: recordedAt,
			setFields: { dependencies, updated_at: recordedAt },
		});
	});
}

export async function removeIssueDependency(
	workspaceRoot: string,
	input: RemoveDependencyInput,
): Promise<Issue> {
	return withBacklogWriteLock(workspaceRoot, async () => {
		const issues = await loadCurrentIssuesUnlocked(workspaceRoot);
		const issue = requireIssue(issues, input.issueId);
		const recordedAt = input.recorded_at ?? nowIso();
		const dependencies = (issue.dependencies ?? []).filter(
			(entry) =>
				!(
					entry.depends_on_id === input.dependsOnId &&
					(input.type === undefined || entry.type === input.type)
				),
		);
		return updateIssueUnlocked(workspaceRoot, {
			issueId: input.issueId,
			actor: input.actor,
			recorded_at: recordedAt,
			setFields: { dependencies, updated_at: recordedAt },
		});
	});
}

export async function addIssueComment(workspaceRoot: string, input: AddCommentInput): Promise<Issue> {
	return withBacklogWriteLock(workspaceRoot, async () => {
		const issues = await loadCurrentIssuesUnlocked(workspaceRoot);
		const issue = requireIssue(issues, input.issueId);
		const recordedAt = input.recorded_at ?? nowIso();
		const nextCommentId = Math.max(0, ...(issue.comments ?? []).map((comment) => comment.id)) + 1;
		const comments = [
			...(issue.comments ?? []),
			{
				id: nextCommentId,
				issue_id: input.issueId,
				author: input.actor,
				text: input.text,
				created_at: recordedAt,
			} satisfies Comment,
		];
		return updateIssueUnlocked(workspaceRoot, {
			issueId: input.issueId,
			actor: input.actor,
			recorded_at: recordedAt,
			setFields: { comments, updated_at: recordedAt },
		});
	});
}

export async function updateIssueFields(
	workspaceRoot: string,
	issueId: string,
	actor: string,
	patch: Partial<Issue>,
	options?: { readonly unsetFields?: ReadonlyArray<string>; readonly recorded_at?: string },
): Promise<Issue> {
	const recordedAt = options?.recorded_at ?? nowIso();
	const setFields: Record<string, unknown> = { ...patch, updated_at: recordedAt };
	if ("labels" in setFields && Array.isArray(setFields["labels"])) {
		setFields["labels"] = uniqueLabels(setFields["labels"] as ReadonlyArray<string>);
	}
	const updateInput: UpdateIssueInput = {
		issueId,
		actor,
		recorded_at: recordedAt,
		setFields,
		...(options?.unsetFields ? { unsetFields: options.unsetFields } : {}),
	};
	return updateIssue(workspaceRoot, updateInput);
}
