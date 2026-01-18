import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function isLinux(): boolean {
	return process.platform === "linux";
}

function safeRealpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

function parsePids(stdout: string): number[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => Number.parseInt(line, 10))
		.filter((n) => Number.isFinite(n) && n > 0);
}

function listPiPids(): number[] {
	try {
		const res = spawnSync("pgrep", ["-x", "pi"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		if (res.status !== 0) return [];
		return parsePids(res.stdout || "");
	} catch {
		return [];
	}
}

function readProcCwd(pid: number): string | undefined {
	try {
		const cwd = fs.readlinkSync(`/proc/${pid}/cwd`, { encoding: "utf-8" });
		return safeRealpath(cwd);
	} catch {
		return undefined;
	}
}

export function listPiProcesses(): Array<{ pid: number; cwd: string }> {
	if (!isLinux()) return [];
	if (!fs.existsSync("/proc")) return [];

	const out: Array<{ pid: number; cwd: string }> = [];
	for (const pid of listPiPids()) {
		const cwd = readProcCwd(pid);
		if (!cwd) continue;
		out.push({ pid, cwd });
	}
	return out;
}

function normalizeForCompare(p: string): string {
	const rp = safeRealpath(p);
	// Keep comparisons stable across trailing slashes.
	return rp.replace(/\/+$/, "");
}

function isSameOrAncestor(ancestor: string, child: string): boolean {
	const a = normalizeForCompare(ancestor);
	const c = normalizeForCompare(child);
	if (a === c) return true;
	const rel = path.relative(a, c);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isOverlapping(ourCwd: string, ourGitRoot: string | null, theirCwd: string): boolean {
	const our = normalizeForCompare(ourCwd);
	const theirs = normalizeForCompare(theirCwd);

	// Direct overlap.
	if (isSameOrAncestor(our, theirs) || isSameOrAncestor(theirs, our)) return true;

	// Same repo root overlap.
	if (ourGitRoot) {
		const root = normalizeForCompare(ourGitRoot);
		if (isSameOrAncestor(root, theirs)) return true;
	}

	return false;
}

export function countOverlappingAgents(
	ourCwd: string,
	ourGitRoot: string | null,
): { count: number; pids: number[] } {
	try {
		const ourPid = process.pid;
		const our = normalizeForCompare(ourCwd);
		const root = ourGitRoot ? normalizeForCompare(ourGitRoot) : null;

		const overlaps: number[] = [];
		for (const p of listPiProcesses()) {
			if (p.pid === ourPid) continue;
			if (!p.cwd) continue;
			if (isOverlapping(our, root, p.cwd)) overlaps.push(p.pid);
		}

		return { count: overlaps.length, pids: overlaps.sort((a, b) => a - b) };
	} catch {
		return { count: 0, pids: [] };
	}
}

