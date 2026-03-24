import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Data, Effect } from "effect";

import { getProjectSettingsPath, getUserSettingsPath } from "./discovery.js";
import { isRecord, type AnyRecord } from "./json.js";

export class SettingsError extends Data.TaggedError("SettingsError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

function parseJsonObject(raw: string, filePath: string): Effect.Effect<AnyRecord, SettingsError> {
	return Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new SettingsError({
				message: `Invalid JSON in ${filePath}`,
				cause,
			}),
	}).pipe(
		Effect.flatMap((json) =>
			isRecord(json)
				? Effect.succeed(json)
				: Effect.fail(
						new SettingsError({
							message: `Invalid JSON in ${filePath}: top-level JSON value must be an object`,
						}),
					),
		),
	);
}

function readJsonObjectFile(filePath: string): Effect.Effect<AnyRecord | null, SettingsError> {
	return Effect.tryPromise({
		try: () => fs.readFile(filePath, "utf-8"),
		catch: (cause) => cause,
	}).pipe(
		Effect.flatMap((raw) => parseJsonObject(raw, filePath)),
		Effect.catchIf(
			(cause) =>
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT",
			() => Effect.succeed(null),
		),
		Effect.mapError((cause) =>
			cause instanceof SettingsError
				? cause
				: new SettingsError({
						message: `Failed to read settings file ${filePath}`,
						cause,
					}),
		),
	);
}

export function findNearestProjectPiDirEffect(
	cwd: string,
): Effect.Effect<string | null, SettingsError> {
	const loop = (current: string): Effect.Effect<string | null, SettingsError> =>
		Effect.tryPromise({
			try: () => fs.stat(path.join(current, ".pi")),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatMap((stats) =>
				stats.isDirectory() ? Effect.succeed(path.join(current, ".pi")) : Effect.succeed(null),
			),
			Effect.catchIf(
				(cause) =>
					typeof cause === "object" &&
					cause !== null &&
					"code" in cause &&
					cause.code === "ENOENT",
				() => {
					const parent = path.dirname(current);
					return parent === current ? Effect.succeed(null) : loop(parent);
				},
			),
			Effect.mapError(
				(cause) =>
					new SettingsError({
						message: `Failed to discover project .pi directory from ${current}`,
						cause,
					}),
			),
		);

	return loop(path.resolve(cwd));
}

export function readUserSettings(): Effect.Effect<AnyRecord | null, SettingsError> {
	return readJsonObjectFile(getUserSettingsPath());
}

export function readProjectSettings(
	cwd: string,
): Effect.Effect<AnyRecord | null, SettingsError> {
	return findNearestProjectPiDirEffect(cwd).pipe(
		Effect.flatMap((projectPiDir) =>
			projectPiDir === null
				? Effect.succeed(null)
				: readJsonObjectFile(getProjectSettingsPath(projectPiDir)),
		),
	);
}

