import type { DependencyType, Issue, IssueStatus, IssueType } from "./schema.js";

export type SortField = "priority" | "created_at" | "updated_at";
export type SortOrder = "asc" | "desc";

export type IssueQuery = {
	readonly status?: IssueStatus | ReadonlyArray<IssueStatus>;
	readonly type?: IssueType | ReadonlyArray<IssueType>;
	readonly priority?: number | ReadonlyArray<number>;
	readonly text?: string;
	readonly ready?: boolean;
	readonly blocked?: boolean;
	readonly sortBy?: SortField;
	readonly order?: SortOrder;
};

const BlockingDependencyTypes = new Set<DependencyType>([
	"blocks",
	"parent-child",
	"conditional-blocks",
	"waits-for",
	"delegated-from",
]);

const normalizeFilter = <T>(value?: T | ReadonlyArray<T>): ReadonlyArray<T> | undefined => {
	if (value === undefined) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value;
	}
	return [value] as ReadonlyArray<T>;
};

const isClosedStatus = (status?: string): boolean => status === "closed" || status === "tombstone";

const isDeferredStatus = (status?: string): boolean => status === "deferred";

const isReadyCandidate = (status?: string): boolean => status === "open" || status === "in_progress";

const hasOpenBlockers = (issue: Issue, byId: ReadonlyMap<string, Issue>): boolean => {
	for (const dep of issue.dependencies ?? []) {
		if (!BlockingDependencyTypes.has(dep.type)) {
			continue;
		}
		const target = byId.get(dep.depends_on_id);
		if (!target) {
			return true;
		}
		if (!isClosedStatus(target.status) && !isDeferredStatus(target.status)) {
			return true;
		}
	}
	return false;
};

const matchesText = (issue: Issue, query: string): boolean => {
	const haystack = `${issue.title} ${issue.description ?? ""} ${issue.notes ?? ""}`
		.toLowerCase()
		.trim();
	return haystack.includes(query.toLowerCase());
};

const toTimestamp = (value?: string): number => {
	if (!value) {
		return 0;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
};

export function filterIssues(
	issues: ReadonlyArray<Issue>,
	query: IssueQuery = {},
): ReadonlyArray<Issue> {
	const statusFilter = normalizeFilter(query.status);
	const typeFilter = normalizeFilter(query.type);
	const priorityFilter = normalizeFilter(query.priority);
	const text = query.text?.trim();
	const byId = new Map(issues.map((issue) => [issue.id, issue]));

	let filtered = issues.filter((issue) => {
		if (statusFilter && !statusFilter.includes(issue.status ?? "")) {
			return false;
		}
		if (typeFilter && !typeFilter.includes(issue.issue_type ?? "")) {
			return false;
		}
		if (priorityFilter && !priorityFilter.includes(issue.priority ?? Number.NaN)) {
			return false;
		}
		if (text && !matchesText(issue, text)) {
			return false;
		}

		if (query.ready === true) {
			if (!isReadyCandidate(issue.status)) {
				return false;
			}
			if (hasOpenBlockers(issue, byId)) {
				return false;
			}
		}

		if (query.blocked === true) {
			if (isClosedStatus(issue.status)) {
				return false;
			}
			if (!hasOpenBlockers(issue, byId)) {
				return false;
			}
		}

		return true;
	});

	const sortBy = query.sortBy ?? "priority";
	const order = query.order ?? "asc";

	filtered = [...filtered].sort((a, b) => {
		let cmp = 0;
		switch (sortBy) {
			case "priority": {
				const aPriority = a.priority ?? 999;
				const bPriority = b.priority ?? 999;
				cmp = aPriority - bPriority;
				break;
			}
			case "created_at": {
				cmp = toTimestamp(a.created_at) - toTimestamp(b.created_at);
				break;
			}
			case "updated_at": {
				cmp = toTimestamp(a.updated_at) - toTimestamp(b.updated_at);
				break;
			}
		}
		return order === "desc" ? -cmp : cmp;
	});

	return filtered;
}
