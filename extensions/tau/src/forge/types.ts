/** Phase of the forge loop. */
export type ForgePhase = "implementing" | "reviewing";

/** Status of a forge instance. */
export type ForgeStatus = "active" | "paused" | "completed";

/** Persisted state for a single forge loop bound to a backlog task. */
export interface ForgeState {
	readonly taskId: string;
	phase: ForgePhase;
	cycle: number;
	status: ForgeStatus;
	reviewer: { model?: string };
	lastFeedback?: string;
	readonly startedAt: string;
	completedAt?: string;
}
