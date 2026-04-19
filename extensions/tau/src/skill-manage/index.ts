import { Effect } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";

import { SkillManager } from "../services/skill-manager.js";
import {
	SkillAlreadyExists,
	SkillFileError,
	SkillInvalidContent,
	SkillInvalidName,
	SkillNotFound,
	SkillPatchFailed,
	SkillSecurityViolation,
} from "./errors.js";

const StringEnum = <T extends string[]>(values: [...T]) =>
	Type.Unsafe<T[number]>({ type: "string", enum: values });

const SkillManageParams = Type.Object({
	action: StringEnum(["create", "patch", "edit", "delete", "write_file", "remove_file"]),
	name: Type.String({
		description: "Skill name (lowercase, hyphens/underscores, max 64 chars).",
	}),
	content: Type.Optional(
		Type.String({
			description:
				"Full SKILL.md content (YAML frontmatter + markdown body). Required for 'create' and 'edit'.",
		}),
	),
	old_string: Type.Optional(
		Type.String({
			description:
				"Text to find (required for 'patch'). Must be unique unless replace_all=true.",
		}),
	),
	new_string: Type.Optional(
		Type.String({
			description:
				"Replacement text (required for 'patch'). Empty string to delete matched text.",
		}),
	),
	replace_all: Type.Optional(
		Type.Boolean({ description: "For 'patch': replace all occurrences (default: false)." }),
	),
	category: Type.Optional(
		Type.String({
			description: "Optional category for organizing (e.g., 'devops'). Only for 'create'.",
		}),
	),
	file_path: Type.Optional(
		Type.String({
			description:
				"Path to supporting file (e.g., 'references/api.md'). For write_file/remove_file/patch.",
		}),
	),
	file_content: Type.Optional(
		Type.String({ description: "Content for the file. Required for 'write_file'." }),
	),
});
type SkillManageParams = Static<typeof SkillManageParams>;

const TOOL_DESCRIPTION =
	"Manage skills (create, update, delete). Skills are your procedural memory — reusable approaches for recurring task types. New skills default to ~/.pi/agent/skills/, and edits/patches can target matching skills discovered from the current workspace as well.\n\nActions: create (full SKILL.md + optional category), patch (old_string/new_string — preferred for fixes), edit (full SKILL.md rewrite — major overhauls only), delete, write_file, remove_file.\n\nCreate when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.\nUpdate when: instructions stale/wrong, missing steps or pitfalls found during use. If you used a skill and hit issues not covered by it, patch it immediately.\n\nAfter difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating/deleting.\n\nGood skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.";

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

type ValidatedSkillManageParams =
	| {
			action: "create";
			name: string;
			content: string;
			category?: string;
	  }
	| {
			action: "patch";
			name: string;
			old_string: string;
			new_string: string;
			replace_all?: boolean;
			file_path?: string;
	  }
	| {
			action: "edit";
			name: string;
			content: string;
	  }
	| {
			action: "delete";
			name: string;
	  }
	| {
			action: "write_file";
			name: string;
			file_path: string;
			file_content: string;
	  }
	| {
			action: "remove_file";
			name: string;
			file_path: string;
	  };

type ValidationResult =
	| { ok: true; params: ValidatedSkillManageParams }
	| { ok: false; result: ToolResult };

function toolOk(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: { success: true } };
}
function toolFail(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: { success: false } };
}

function getToolCwd(ctx: unknown): string {
	if (typeof ctx !== "object" || ctx === null || !("cwd" in ctx)) {
		return process.cwd();
	}
	const cwd = ctx.cwd;
	return typeof cwd === "string" ? cwd : process.cwd();
}

function validateParams(params: SkillManageParams): ValidationResult {
	switch (params.action) {
		case "create": {
			if (params.content === undefined) {
				return { ok: false, result: toolFail("content is required for 'create' action.") };
			}
			const validatedParams: ValidatedSkillManageParams = {
				action: "create",
				name: params.name,
				content: params.content,
				...(params.category === undefined ? {} : { category: params.category }),
			};
			return {
				ok: true,
				params: validatedParams,
			};
		}
		case "edit": {
			if (params.content === undefined) {
				return { ok: false, result: toolFail("content is required for 'edit' action.") };
			}
			return {
				ok: true,
				params: {
					action: "edit",
					name: params.name,
					content: params.content,
				},
			};
		}
		case "patch": {
			if (params.old_string === undefined) {
				return {
					ok: false,
					result: toolFail("old_string is required for 'patch' action."),
				};
			}
			if (params.new_string === undefined) {
				return {
					ok: false,
					result: toolFail("new_string is required for 'patch' action."),
				};
			}
			const validatedParams: ValidatedSkillManageParams = {
				action: "patch",
				name: params.name,
				old_string: params.old_string,
				new_string: params.new_string,
				...(params.replace_all === undefined ? {} : { replace_all: params.replace_all }),
				...(params.file_path === undefined ? {} : { file_path: params.file_path }),
			};
			return {
				ok: true,
				params: validatedParams,
			};
		}
		case "delete": {
			return { ok: true, params: { action: "delete", name: params.name } };
		}
		case "write_file": {
			if (params.file_path === undefined) {
				return {
					ok: false,
					result: toolFail("file_path is required for 'write_file' action."),
				};
			}
			if (params.file_content === undefined) {
				return {
					ok: false,
					result: toolFail("file_content is required for 'write_file' action."),
				};
			}
			return {
				ok: true,
				params: {
					action: "write_file",
					name: params.name,
					file_path: params.file_path,
					file_content: params.file_content,
				},
			};
		}
		case "remove_file": {
			if (params.file_path === undefined) {
				return {
					ok: false,
					result: toolFail("file_path is required for 'remove_file' action."),
				};
			}
			return {
				ok: true,
				params: {
					action: "remove_file",
					name: params.name,
					file_path: params.file_path,
				},
			};
		}
	}
}

export function createSkillManageToolDefinition(
	runEffect: <A, E>(effect: Effect.Effect<A, E, SkillManager>) => Promise<A>,
): ToolDefinition<typeof SkillManageParams> {
	return {
		name: "skill_manage",
		label: "skill_manage",
		description: TOOL_DESCRIPTION,
		parameters: SkillManageParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
			const params = rawParams as SkillManageParams;
			const cwd = getToolCwd(_ctx);
			const validation = validateParams(params);
			if (!validation.ok) {
				return validation.result;
			}

			const program = Effect.gen(function* () {
				const skillManager = yield* SkillManager;
				switch (validation.params.action) {
					case "create": {
						const result = yield* skillManager.create(
							validation.params.name,
							validation.params.content,
							validation.params.category,
							cwd,
						);
						return `Skill '${result.name}' created at ${result.path}.`;
					}
					case "edit": {
						yield* skillManager.edit(
							validation.params.name,
							validation.params.content,
							cwd,
						);
						return `Skill '${validation.params.name}' updated.`;
					}
					case "patch": {
						const result = yield* skillManager.patch(
							validation.params.name,
							validation.params.old_string,
							validation.params.new_string,
							validation.params.file_path,
							validation.params.replace_all,
							cwd,
						);
						return `Patched ${result.replacements} replacement(s) in skill '${result.name}'.`;
					}
					case "delete": {
						yield* skillManager.remove(validation.params.name, cwd);
						return `Skill '${validation.params.name}' deleted.`;
					}
					case "write_file": {
						const result = yield* skillManager.writeFile(
							validation.params.name,
							validation.params.file_path,
							validation.params.file_content,
							cwd,
						);
						return `File '${result.filePath}' written to skill '${result.name}'.`;
					}
					case "remove_file": {
						const result = yield* skillManager.removeFile(
							validation.params.name,
							validation.params.file_path,
							cwd,
						);
						return `File '${result.filePath}' removed from skill '${result.name}'.`;
					}
				}
			});

			try {
				return toolOk(await runEffect(program));
			} catch (cause: unknown) {
				if (cause instanceof SkillNotFound)
					return toolFail(`Skill '${cause.name}' not found.`);
				if (cause instanceof SkillAlreadyExists)
					return toolFail(`Skill '${cause.name}' already exists at ${cause.path}.`);
				if (cause instanceof SkillInvalidName)
					return toolFail(`Invalid skill name '${cause.name}': ${cause.reason}`);
				if (cause instanceof SkillInvalidContent)
					return toolFail(`Invalid skill content: ${cause.reason}`);
				if (cause instanceof SkillFileError)
					return toolFail(`Skill file error: ${cause.reason}`);
				if (cause instanceof SkillSecurityViolation)
					return toolFail(`Skill content rejected: ${cause.reason}`);
				if (cause instanceof SkillPatchFailed)
					return toolFail(
						`Patch failed for skill '${validation.params.name}': ${cause.reason}`,
					);
				return toolFail(cause instanceof Error ? cause.message : String(cause));
			}
		},
	};
}

export default function initSkillManage(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, SkillManager>) => Promise<A>,
): void {
	pi.registerTool(createSkillManageToolDefinition(runEffect));
}
