/** Phase of the forge loop. */
export type ForgePhase = "implementing" | "reviewing";

/** Status of a forge instance. */
export type ForgeStatus = "active" | "paused" | "completed";

export interface ForgeReviewCodeLocation {
	absolute_file_path: string;
	line_range: {
		start: number;
		end: number;
	};
}

export interface ForgeReviewFinding {
	title: string;
	body: string;
	confidence_score: number;
	priority: number;
	code_location: ForgeReviewCodeLocation;
}

export interface ForgeReviewResult {
	findings: ForgeReviewFinding[];
	overall_correctness: "patch is correct" | "patch is incorrect";
	overall_explanation: string;
	overall_confidence_score: number;
}

/** Persisted state for a single forge loop bound to a backlog task. */
export interface ForgeState {
	readonly taskId: string;
	phase: ForgePhase;
	cycle: number;
	status: ForgeStatus;
	implementer?: { model?: string; thinking?: string };
	reviewer: { model?: string; thinking?: string };
	lastImplementerMessage?: string;
	lastReview?: ForgeReviewResult;
	lastFeedback?: string;
	readonly startedAt: string;
	completedAt?: string;
}
