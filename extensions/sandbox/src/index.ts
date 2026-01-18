import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";

import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createWriteTool,
  getSettingsListTheme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  SettingsList,
  Text,
  type SettingItem,
} from "@mariozechner/pi-tui";

import {
  checkBashApproval,
  checkFilesystemApproval,
  looksLikePolicyViolation,
  requestApprovalAfterFailure,
} from "./approval.js";
import { classifySandboxFailure } from "./sandbox-diagnostics.js";
import {
  buildSandboxChangeNoticeText,
  computeSandboxConfigHash,
  injectSandboxNoticeIntoMessages,
} from "./sandbox-change.js";
import type { ApprovalPolicy, FilesystemMode, NetworkMode, SandboxConfig } from "./config.js";
import { computeEffectiveConfig, ensureUserDefaults } from "./config.js";
import { checkWriteAllowed } from "./fs-policy.js";
import { wrapCommandWithSandbox, isAsrtAvailable, getAsrtLoadError } from "./sandbox-bash.js";
import { detectMissingSandboxDeps, formatMissingDepsMessage } from "./sandbox-prereqs.js";
import { discoverWorkspaceRoot } from "./workspace-root.js";

/**
 * Kill a process and all its children.
 */
function killProcessTree(pid: number): void {
  try {
    // On Unix, kill the process group
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      // Fallback: kill just the process
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
  }
}

const STATE_TYPE = "sandbox_state";
const SANDBOX_CHANGE_MESSAGE_TYPE = "sandbox:change";
const INHERIT = "inherit";

const FILESYSTEM_VALUES = [
  INHERIT,
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
const NETWORK_VALUES = [INHERIT, "deny", "allowlist", "allow-all"] as const;
const APPROVAL_VALUES = [INHERIT, "never", "on-failure", "on-request", "unless-trusted"] as const;
const TIMEOUT_VALUES = [INHERIT, "15", "30", "60", "120", "300"] as const;

type SessionState = {
  override?: SandboxConfig;
  /**
   * When ASRT is unavailable due to missing deps, we prompt once per session.
   * This caches the user's choice.
   */
  sandboxUnavailableDecision?: "allow" | "deny";

  /**
   * True once we have injected initial sandbox state into the system prompt
   * on the first model turn.
   */
  systemPromptInjected?: boolean;

  /** Hash of the sandbox config last communicated to the model. */
  lastCommunicatedHash?: string;

  /** Pending SANDBOX_CHANGE notice to inject into the next user message as content[0]. */
  pendingSandboxNotice?: { hash: string; text: string };
};

function loadSessionState(ctx: ExtensionContext): SessionState | undefined {
  const entries = ctx.sessionManager.getBranch();
  let last: SessionState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      last = entry.data as SessionState | undefined;
    }
  }

  if (!last) return undefined;

  // Defensive copy.
  return {
    ...last,
    override: last.override ? { ...last.override } : undefined,
    pendingSandboxNotice: last.pendingSandboxNotice
      ? { ...last.pendingSandboxNotice }
      : undefined,
  };
}

function parseAllowlist(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function formatAllowlist(list: string[]): string {
  if (list.length === 0) return "(none)";
  if (list.length <= 3) return list.join(", ");
  return `${list.length} domains`;
}

function buildSourceHint(
  sessionOverride: SandboxConfig | undefined,
  key: keyof SandboxConfig,
): string {
  return sessionOverride?.[key] !== undefined
    ? "session override"
    : "inherited";
}

export default function sandbox(pi: ExtensionAPI) {
  // Register CLI flags for testing sandbox modes
  pi.registerFlag("sandbox-fs", {
    description: "Filesystem sandbox mode (read-only, workspace-write, danger)",
    type: "string",
  });
  pi.registerFlag("sandbox-net", {
    description: "Network sandbox mode (deny, allow)",
    type: "string",
  });
  pi.registerFlag("approval-policy", {
    description: "Approval policy (never, on-failure, on-request, unless-trusted)",
    type: "string",
  });
  pi.registerFlag("no-sandbox", {
    description: "Completely disable ASRT sandbox wrapper (escape hatch)",
    type: "boolean",
  });

  // Track if sandbox is completely disabled via --no-sandbox flag
  let sandboxDisabled = false;

  // First-run: ensure sandbox defaults are written into ~/.pi/agent/settings.json (only fills missing keys).
  ensureUserDefaults();

  let workspaceRoot = process.cwd();
  let sessionState: SessionState = {};
  let sessionOverride: SandboxConfig | undefined = sessionState.override;
  let effectiveConfig = computeEffectiveConfig({
    workspaceRoot,
    sessionOverride,
  });
  let cliOverride: SandboxConfig | undefined;

  function refreshConfig(ctx: ExtensionContext) {
    workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
    sessionState = loadSessionState(ctx) ?? {};
    sessionOverride = sessionState.override;

    // Merge CLI override with session override (CLI takes precedence)
    const mergedOverride = { ...sessionOverride, ...cliOverride };
    effectiveConfig = computeEffectiveConfig({
      workspaceRoot,
      sessionOverride: mergedOverride,
    });
  }

  function persistState() {
    // Keep sessionState.override in sync with the current override.
    sessionState.override = sessionOverride;
    pi.appendEntry<SessionState>(STATE_TYPE, sessionState);
  }

  function sendSandboxChangeHistoryEntry(text: string): void {
    // UI-only history entry. Must not trigger a new turn.
    pi.sendMessage(
      {
        customType: SANDBOX_CHANGE_MESSAGE_TYPE,
        content: text,
        display: true,
        details: undefined,
      },
      { triggerTurn: false },
    );
  }

  function queueSandboxChangeNotice(prevHash: string, nextHash: string) {
    // If the effective config didn't change, don't emit anything.
    if (prevHash === nextHash) return;

    // We only emit SANDBOX_CHANGE after we've established initial sandbox state
    // via a first-turn system prompt injection.
    if (!sessionState.systemPromptInjected) return;

    // If we don't know what we last communicated, treat current as baseline.
    if (!sessionState.lastCommunicatedHash) {
      sessionState.lastCommunicatedHash = prevHash;
    }

    // Full circle: back to baseline -> clear pending notice.
    if (nextHash === sessionState.lastCommunicatedHash) {
      sessionState.pendingSandboxNotice = undefined;
      return;
    }

    // Overwrite any previous pending notice: we only want the latest.
    sessionState.pendingSandboxNotice = {
      hash: nextHash,
      text: buildSandboxChangeNoticeText(effectiveConfig),
    };
  }

  function setOverrideValue<K extends keyof SandboxConfig>(
    key: K,
    value: SandboxConfig[K] | undefined,
  ) {
    const prevHash = computeSandboxConfigHash(effectiveConfig);

    const next: SandboxConfig = { ...(sessionOverride ?? {}) };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }

    sessionOverride = Object.keys(next).length > 0 ? next : undefined;
    effectiveConfig = computeEffectiveConfig({
      workspaceRoot,
      sessionOverride,
    });

    const nextHash = computeSandboxConfigHash(effectiveConfig);
    queueSandboxChangeNotice(prevHash, nextHash);

    persistState();
  }

  /** Get the display value for UI - shows "inherit" if no override, otherwise the actual value */
  function getDisplayValue<K extends keyof SandboxConfig>(key: K): string {
    if (!sessionOverride) {
      return INHERIT;
    }
    const override = sessionOverride[key];
    if (override === undefined) {
      return INHERIT;
    }
    if (Array.isArray(override)) {
      return formatAllowlist(override as string[]);
    }
    return override as string;
  }

  function updateSettingFromSelect<K extends keyof SandboxConfig>(
    key: K,
    value: string,
  ) {
    if (value === INHERIT) {
      setOverrideValue(key, undefined);
      return;
    }
    setOverrideValue(key, value as SandboxConfig[K]);
  }

  function updateAllowlistFromInput(rawValue: string) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setOverrideValue("networkAllowlist", []);
      return;
    }
    if (trimmed.toLowerCase() === INHERIT) {
      setOverrideValue("networkAllowlist", undefined);
      return;
    }
    setOverrideValue("networkAllowlist", parseAllowlist(trimmed));
  }

  function updateTimeoutFromSelect(rawValue: string, ctx: ExtensionContext) {
    if (rawValue === INHERIT) {
      setOverrideValue("approvalTimeoutSeconds", undefined);
      return;
    }
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.ui.notify(`Invalid timeout: ${rawValue}`, "warning");
      return;
    }
    setOverrideValue("approvalTimeoutSeconds", parsed);
  }

  function buildSandboxSummary(): string {
    const lines = [
      "Sandbox configuration:",
      `Filesystem: ${effectiveConfig.filesystemMode}`,
      `Network: ${effectiveConfig.networkMode}`,
      `Allowlist: ${formatAllowlist(effectiveConfig.networkAllowlist)}`,
      `Approval: ${effectiveConfig.approvalPolicy}`,
      `Timeout: ${effectiveConfig.approvalTimeoutSeconds}s`,
    ];
    return lines.join("\n");
  }

 async function showSandboxSettings(ctx: ExtensionContext) {
   const baselineHash = computeSandboxConfigHash(effectiveConfig);

   if (!ctx.hasUI) {
     console.log(buildSandboxSummary());
     return;
   }

   await ctx.ui.custom((tui, theme, _kb, done) => {
     const items: SettingItem[] = [
       {
         id: "filesystemMode",
         label: "Filesystem mode",
         currentValue: getDisplayValue("filesystemMode"),
         values: [...FILESYSTEM_VALUES],
         description: buildSourceHint(sessionOverride, "filesystemMode"),
       },
       {
         id: "networkMode",
         label: "Network mode",
         currentValue: getDisplayValue("networkMode"),
         values: [...NETWORK_VALUES],
         description: buildSourceHint(sessionOverride, "networkMode"),
       },
       {
         id: "networkAllowlist",
         label: "Network allowlist",
         currentValue: getDisplayValue("networkAllowlist"),
         description: `Used when network mode is allowlist (${buildSourceHint(
           sessionOverride,
           "networkAllowlist",
         )})`,
         submenu: (_currentValue, doneSubmenu) => {
           const input = new Input();
           input.setValue(effectiveConfig.networkAllowlist.join(", "));
           input.onSubmit = (value) => doneSubmenu(value);
           input.onEscape = () => doneSubmenu(undefined);

           return {
             render(width: number) {
               const lines: string[] = [];
               lines.push(
                 theme.fg("accent", theme.bold("Edit network allowlist")),
               );
               lines.push(
                 theme.fg(
                   "muted",
                   "Comma-separated domains. Type 'inherit' to reset.",
                 ),
               );
               lines.push("");
               lines.push(...input.render(width));
               lines.push("");
               lines.push(theme.fg("dim", "Enter to save · Esc to cancel"));
               return lines;
             },
             handleInput(data: string) {
               input.handleInput(data);
               tui.requestRender();
             },
             invalidate() {
               input.invalidate?.();
             },
           };
         },
       },
        {
          id: "approvalPolicy",
          label: "Approval policy",
          currentValue: getDisplayValue("approvalPolicy"),
          values: [...APPROVAL_VALUES],
          description: buildSourceHint(sessionOverride, "approvalPolicy"),
        },
        {
          id: "approvalTimeoutSeconds",
          label: "Approval timeout (s)",
          currentValue: getDisplayValue("approvalTimeoutSeconds"),
          values: [...TIMEOUT_VALUES],
          description: buildSourceHint(
            sessionOverride,
            "approvalTimeoutSeconds",
          ),
        },
      ];

      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Sandbox settings")), 1, 1),
      );

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === "filesystemMode") {
            updateSettingFromSelect("filesystemMode", newValue);
          }
          if (id === "networkMode") {
            updateSettingFromSelect("networkMode", newValue);
          }
          if (id === "networkAllowlist") {
            updateAllowlistFromInput(newValue);
          }
          if (id === "approvalPolicy") {
            updateSettingFromSelect("approvalPolicy", newValue);
          }
          if (id === "approvalTimeoutSeconds") {
            updateTimeoutFromSelect(newValue, ctx);
          }

          items.find((item) => item.id === "filesystemMode")!.description =
            buildSourceHint(sessionOverride, "filesystemMode");
          items.find((item) => item.id === "networkMode")!.description =
            buildSourceHint(sessionOverride, "networkMode");
          items.find((item) => item.id === "networkAllowlist")!.description =
            `Used when network mode is allowlist (${buildSourceHint(
              sessionOverride,
              "networkAllowlist",
            )})`;
          items.find((item) => item.id === "approvalPolicy")!.description =
            buildSourceHint(sessionOverride, "approvalPolicy");
          items.find(
            (item) => item.id === "approvalTimeoutSeconds",
          )!.description = buildSourceHint(
            sessionOverride,
            "approvalTimeoutSeconds",
          );

          settingsList.updateValue(
            "filesystemMode",
            getDisplayValue("filesystemMode"),
          );
          settingsList.updateValue("networkMode", getDisplayValue("networkMode"));
          settingsList.updateValue(
            "networkAllowlist",
            getDisplayValue("networkAllowlist"),
          );
          settingsList.updateValue(
            "approvalPolicy",
            getDisplayValue("approvalPolicy"),
          );
          settingsList.updateValue(
            "approvalTimeoutSeconds",
            getDisplayValue("approvalTimeoutSeconds"),
          );
        },
        () => done(undefined),
      );
      container.addChild(settingsList);

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          settingsList.handleInput?.(data);
          tui.requestRender();
        },
     };
   });

   const finalHash = computeSandboxConfigHash(effectiveConfig);
   if (finalHash !== baselineHash) {
     // Visible to the user in session history (but filtered out of LLM context).
     sendSandboxChangeHistoryEntry(buildSandboxChangeNoticeText(effectiveConfig));
   }
 }

  const baseBashTool = createBashTool(process.cwd());
  const baseEditTool = createEditTool(process.cwd());
  const baseWriteTool = createWriteTool(process.cwd());

  function singleLine(str: string): string {
    return (str ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }

  async function ensureUnsandboxedAllowedOnSandboxUnavailable(
    ctx: ExtensionContext,
    reason: string,
    timeoutSeconds: number,
  ): Promise<boolean> {
    // Cached per-session decision
    if (sessionState.sandboxUnavailableDecision === "allow") return true;
    if (sessionState.sandboxUnavailableDecision === "deny") return false;

    if (!ctx.hasUI) {
      // Headless: default deny.
      sessionState.sandboxUnavailableDecision = "deny";
      persistState();
      return false;
    }

    const approved = await ctx.ui.confirm(
      "Sandbox unavailable",
      `Sandboxed bash is unavailable.\n\nReason: ${reason}\n\nRun bash without sandbox for this session? (edit/write restrictions still apply)`,
      { timeout: timeoutSeconds * 1000 },
    );

    sessionState.sandboxUnavailableDecision = approved ? "allow" : "deny";
    persistState();
    return approved;
  }

  // Factory to create sandboxed bash operations with captured context (avoids global state race conditions)
  function createSandboxedBashOperations(ctx: ExtensionContext, escalate: boolean): BashOperations {
    return {
      async exec(command, cwd, { onData, signal, timeout }) {
        // If sandbox is completely disabled, run commands directly
        if (sandboxDisabled) {
          return runCommandDirect(
            command,
            cwd,
            process.env as Record<string, string>,
            { onData, signal, timeout },
          );
        }

        const currentConfig = effectiveConfig;
        const currentWorkspace = workspaceRoot;
        const approvalTimeout = currentConfig.approvalTimeoutSeconds;

        // Check approval based on policy (using captured ctx)
        const approval = await checkBashApproval(
          ctx,
          currentConfig.approvalPolicy,
          command,
          escalate,
          { timeoutSeconds: approvalTimeout },
        );

        if (!approval.approved) {
          const errorMsg = `Sandbox: command blocked (${approval.reason})\n`;
          onData(Buffer.from(errorMsg));
          return { exitCode: 1 };
        }

        // If approval says run unsandboxed, do that
        if (approval.runUnsandboxed) {
          ctx.ui?.notify?.("Running without sandbox...", "info");
          return runCommandDirect(
            command,
            cwd,
            process.env as Record<string, string>,
            { onData, signal, timeout },
          );
        }

        // Ensure sandbox prerequisites exist. If we can't enforce the sandbox,
        // prompt once per session before falling back to unsandboxed execution.
        const prereqs = detectMissingSandboxDeps({ platform: os.platform() });
        const asrtAvailable = await isAsrtAvailable();

        if (!asrtAvailable || prereqs.missingRequired.length > 0) {
          const parts: string[] = [];
          if (!asrtAvailable) {
            parts.push(getAsrtLoadError() ?? "ASRT module failed to load");
          }
          const depsMsg = formatMissingDepsMessage(prereqs);
          if (depsMsg) parts.push(depsMsg);
          const reason = parts.join("; ");

          const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(ctx, reason, approvalTimeout);
          if (!allowUnsandboxed) {
            onData(Buffer.from(`[sandbox] Sandboxed bash unavailable (${reason}). Refusing to run without sandbox.\n`));
            return { exitCode: 1 };
          }

          onData(Buffer.from(`[sandbox] Sandboxed bash unavailable (${reason}). Running without sandbox for this session.\n`));
          return runCommandDirect(
            command,
            cwd,
            process.env as Record<string, string>,
            { onData, signal, timeout },
          );
        }

        // Try to wrap with ASRT
        const wrapResult = await wrapCommandWithSandbox({
          command,
          workspaceRoot: currentWorkspace,
          filesystemMode: currentConfig.filesystemMode,
          networkMode: currentConfig.networkMode,
          networkAllowlist: currentConfig.networkAllowlist,
        });

        if (!wrapResult.success) {
          const reason = singleLine(wrapResult.error);
          const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(ctx, reason, approvalTimeout);

          if (!allowUnsandboxed) {
            onData(Buffer.from(`[sandbox] Failed to start sandbox (${reason}). Refusing to run without sandbox.\n`));
            return { exitCode: 1 };
          }

          onData(Buffer.from(`[sandbox] Failed to start sandbox (${reason}). Running without sandbox for this session.\n`));
          return runCommandDirect(
            command,
            cwd,
            process.env as Record<string, string>,
            { onData, signal, timeout },
          );
        }

        const finalCommand = wrapResult.wrappedCommand;
        const env = { ...process.env, HOME: wrapResult.home };
        const usingSandbox = true;

        // Run the command (sandboxed)
        const result = await runCommandCapture(
          finalCommand,
          cwd,
          env as Record<string, string>,
          { onData, signal, timeout },
        );

        // Emit a best-effort diagnostic when a sandboxed command fails. This helps the model
        // distinguish between genuine command failures and sandbox restrictions.
        if (usingSandbox && result.exitCode !== 0) {
          const classification = classifySandboxFailure(result.output);

          const gatedByConfig =
            classification.kind !== "unknown" &&
            (classification.kind !== "network" || currentConfig.networkMode !== "allow-all") &&
            (classification.kind !== "filesystem" || currentConfig.filesystemMode !== "danger-full-access");

          if (gatedByConfig) {
            const type =
              classification.kind === "network"
                ? `network/${classification.subtype}`
                : classification.kind === "filesystem"
                  ? `filesystem/${classification.subtype}`
                  : "unknown";

            const evidence = singleLine(classification.evidence);

            const hint =
              classification.kind === "network"
                ? "Network sandboxing can surface as DNS/connectivity failures. If network is required, use /sandbox to switch to allowlist/allow-all, or re-run with escalate=true."
                : classification.kind === "filesystem"
                  ? "Filesystem sandboxing can surface as permission errors. If a write is required, use /sandbox to switch to workspace-write/danger-full-access, or re-run with escalate=true."
                  : "";

            onData(
              Buffer.from(
                `[sandbox] Command failed likely due to sandbox restrictions (${type}). (fs=${currentConfig.filesystemMode}, net=${currentConfig.networkMode}). Evidence: "${evidence}". ${hint}\n`,
              ),
            );

            const diagnostic = {
              usingSandbox: true,
              filesystemMode: currentConfig.filesystemMode,
              networkMode: currentConfig.networkMode,
              networkAllowlist: currentConfig.networkMode === "allowlist" ? currentConfig.networkAllowlist : null,
              classification,
            };

            onData(Buffer.from(`SANDBOX_DIAGNOSTIC=${JSON.stringify(diagnostic)}\n`));
          }
        }

        // Check if we should offer retry on failure (for "on-failure" policy)
        if (
          result.exitCode !== 0 &&
          usingSandbox &&
          currentConfig.approvalPolicy === "on-failure" &&
          looksLikePolicyViolation(result.output)
        ) {
          try {
            const retryApproval = await requestApprovalAfterFailure(
              ctx,
              command,
              result.output,
              { timeoutSeconds: approvalTimeout },
            );

            if (retryApproval.approved && retryApproval.runUnsandboxed) {
              ctx.ui?.notify?.("Retrying without sandbox...", "info");
              const retryResult = await runCommandDirect(
                command,
                cwd,
                process.env as Record<string, string>,
                { onData, signal, timeout },
              );
              return { exitCode: retryResult.exitCode };
            }
          } catch (err) {
            console.error("[sandbox] Retry approval failed:", err);
          }
        }

        return { exitCode: result.exitCode };
      },
    };
  }

  // Run command and capture output for policy violation detection
  function runCommandCapture(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    opts: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    },
  ): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}`));
        return;
      }

      let outputBuffer = "";
      const { onData, signal, timeout } = opts;

      const child = spawn("bash", ["-lc", cmd], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killProcessTree(child.pid);
          }
        }, timeout * 1000);
      }

      if (child.stdout) {
        child.stdout.on("data", (data) => {
          outputBuffer += data.toString();
          onData(data);
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (data) => {
          outputBuffer += data.toString();
          onData(data);
        });
      }

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      const onAbort = () => {
        if (child.pid) {
          killProcessTree(child.pid);
        }
      };

      if (signal) {
        signal.addEventListener("abort", onAbort);
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (timedOut) {
          resolve({ exitCode: null, output: outputBuffer });
        } else {
          resolve({ exitCode: code, output: outputBuffer });
        }
      });
    });
  }
  // Run command directly without output capture (for approved/retry runs)
  function runCommandDirect(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    opts: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    },
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}`));
        return;
      }

      const { onData, signal, timeout } = opts;

      const child = spawn("bash", ["-lc", cmd], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killProcessTree(child.pid);
          }
        }, timeout * 1000);
      }

      if (child.stdout) {
        child.stdout.on("data", onData);
      }
      if (child.stderr) {
        child.stderr.on("data", onData);
      }

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      const onAbort = () => {
        if (child.pid) {
          killProcessTree(child.pid);
        }
      };

      if (signal) {
        signal.addEventListener("abort", onAbort);
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (timedOut) {
          resolve({ exitCode: null });
        } else {
          resolve({ exitCode: code });
        }
      });
    });
  }
  pi.registerTool({
    ...baseBashTool,
    label: "bash",
    // Extend schema to add escalate parameter
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
        escalate: {
          type: "boolean",
          description: "Request to run without sandbox restrictions. Only use when sandbox is blocking necessary operations."
        },
      },
      required: ["command"],
    },
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      refreshConfig(ctx);

      const typedParams = params as { command: string; timeout?: number; escalate?: boolean };
      const escalate = typedParams.escalate ?? false;

      // Create tool with operations that capture ctx in closure (no global state)
      const tool = createBashTool(ctx.cwd, {
        operations: createSandboxedBashOperations(ctx, escalate),
      });

      // Pass params without escalate to inner tool
      const innerParams = { command: typedParams.command, timeout: typedParams.timeout };
      return await tool.execute(toolCallId, innerParams, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseEditTool,
    label: "edit",
    async execute(toolCallId, params, _onUpdate, ctx, signal) {
      refreshConfig(ctx);
      const targetPath = (params as { path?: string }).path;
      if (targetPath) {
        const check = checkWriteAllowed({
          targetPath,
          workspaceRoot,
          filesystemMode: effectiveConfig.filesystemMode,
        });
        if (!check.allowed) {
          const approval = await checkFilesystemApproval(
            ctx,
            effectiveConfig.approvalPolicy,
            targetPath,
            "edit",
            { timeoutSeconds: effectiveConfig.approvalTimeoutSeconds },
          );

         if (!approval.approved) {
            return {
              content: [{ type: "text" as const, text: `Error: ${check.reason} (${approval.reason})` }],
              details: undefined,
            };
         }

         ctx.ui.notify(`Approved: edit ${targetPath}`, "info");
        }
      }
      const tool = createEditTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal);
    },
  });

  pi.registerTool({
    ...baseWriteTool,
    label: "write",
    async execute(toolCallId, params, _onUpdate, ctx, signal) {
      refreshConfig(ctx);
      const targetPath = (params as { path?: string }).path;
      if (targetPath) {
        const check = checkWriteAllowed({
          targetPath,
          workspaceRoot,
          filesystemMode: effectiveConfig.filesystemMode,
        });
        if (!check.allowed) {
          const approval = await checkFilesystemApproval(
            ctx,
            effectiveConfig.approvalPolicy,
            targetPath,
            "write",
            { timeoutSeconds: effectiveConfig.approvalTimeoutSeconds },
          );

         if (!approval.approved) {
            return {
              content: [{ type: "text" as const, text: `Error: ${check.reason} (${approval.reason})` }],
              details: undefined,
            };
         }

         ctx.ui.notify(`Approved: write ${targetPath}`, "info");
        }
      }
      const tool = createWriteTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Check for --no-sandbox escape hatch first
    const noSandbox = pi.getFlag("no-sandbox") as boolean | undefined;
    if (noSandbox) {
      sandboxDisabled = true;
      ctx.ui.notify("Sandbox DISABLED via --no-sandbox flag", "warning");
      return;
    }

    // Apply CLI flags
    const sandboxFs = pi.getFlag("sandbox-fs") as string | undefined;
    const sandboxNet = pi.getFlag("sandbox-net") as string | undefined;
    const approvalPolicy = pi.getFlag("approval-policy") as string | undefined;

    if (sandboxFs || sandboxNet || approvalPolicy) {
      cliOverride = {};

      if (sandboxFs) {
        const fsMap: Record<string, FilesystemMode> = {
          "read-only": "read-only",
          readonly: "read-only",
          "workspace-write": "workspace-write",
          workspace: "workspace-write",
          danger: "danger-full-access",
          "danger-full-access": "danger-full-access",
        };
        const mapped = fsMap[sandboxFs.toLowerCase()];
        if (mapped) {
          cliOverride.filesystemMode = mapped;
          ctx.ui.notify(`Sandbox filesystem mode: ${mapped}`, "info");
        } else {
          ctx.ui.notify(
            `Invalid --sandbox-fs value: ${sandboxFs}. Use: read-only, workspace-write, danger`,
            "warning",
          );
        }
      }

      if (sandboxNet) {
        const netMap: Record<string, NetworkMode> = {
          deny: "deny",
          block: "deny",
          allow: "allow-all",
          "allow-all": "allow-all",
          allowlist: "allowlist",
          "allow-list": "allowlist",
        };
        const mapped = netMap[sandboxNet.toLowerCase()];
        if (mapped) {
          cliOverride.networkMode = mapped;
          ctx.ui.notify(`Sandbox network mode: ${mapped}`, "info");
        } else {
          ctx.ui.notify(
            `Invalid --sandbox-net value: ${sandboxNet}. Use: deny, allow-all, allowlist`,
            "warning",
          );
        }
      }

      if (approvalPolicy) {
        const policyMap: Record<string, ApprovalPolicy> = {
          never: "never",
          "on-failure": "on-failure",
          onfailure: "on-failure",
          "on-request": "on-request",
          onrequest: "on-request",
          "unless-trusted": "unless-trusted",
          untrusted: "unless-trusted",
        };
        const mapped = policyMap[approvalPolicy.toLowerCase()];
        if (mapped) {
          cliOverride.approvalPolicy = mapped;
          ctx.ui.notify(`Sandbox approval policy: ${mapped}`, "info");
        } else {
          ctx.ui.notify(
            `Invalid --approval-policy value: ${approvalPolicy}. Use: never, on-failure, on-request, unless-trusted`,
            "warning",
          );
        }
      }
    }

    refreshConfig(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshConfig(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    refreshConfig(ctx);
  });

  // First turn only: inject initial sandbox state into the system prompt.
  // Subsequent sandbox changes are injected into the user message as content[0]
  // (see context handler below) to preserve provider prompt caching.
  pi.on("before_agent_start", async (event, ctx) => {
    refreshConfig(ctx);

    if (sessionState.systemPromptInjected) return;

    sessionState.systemPromptInjected = true;
    sessionState.lastCommunicatedHash = computeSandboxConfigHash(effectiveConfig);
    sessionState.pendingSandboxNotice = undefined;
    persistState();

    const allowlistText =
      effectiveConfig.networkMode === "allowlist"
        ? effectiveConfig.networkAllowlist.length > 0
          ? effectiveConfig.networkAllowlist.join(", ")
          : "(none)"
        : "n/a";

    const injected =
      "<permissions instructions>\n" +
      "Assume all tool calls execute under sandbox restrictions. Do not attempt to bypass restrictions by using other tools.\n" +
      "\n" +
      `Filesystem: ${effectiveConfig.filesystemMode}\n` +
      "  - read-only: writes only to temp dirs (e.g. /tmp, $TMPDIR)\n" +
      `  - workspace-write: writes to workspace (${workspaceRoot}) + temp dirs; .git/hooks blocked\n` +
      "  - danger-full-access: unrestricted\n" +
      "  Reads always allowed everywhere.\n" +
      "\n" +
      `Network: ${effectiveConfig.networkMode}\n` +
      "  - deny: outbound blocked (often surfaces as DNS errors like \"Could not resolve host\")\n" +
      `  - allowlist: only these domains reachable: ${allowlistText}\n` +
      "  - allow-all: unrestricted\n" +
      "\n" +
      `Approval: ${effectiveConfig.approvalPolicy}\n` +
      "  - on-failure: runs sandboxed; prompts on likely sandbox-related failure to retry unsandboxed\n" +
      "  - on-request: runs sandboxed unless tool call requests escalation (e.g. escalate=true)\n" +
      "  - unless-trusted: auto-approves safe read-only commands; prompts for unsafe\n" +
      "  - never: no prompts; sandbox errors returned to you\n" +
      "\n" +
      "On sandbox failures, output may include: SANDBOX_DIAGNOSTIC=<json> (machine-readable).\n" +
      "Mid-session changes notified via: SANDBOX_CHANGE: fs=... net=... allowlist=... approval=...\n" +
      "</permissions instructions>";

    return {
      systemPrompt: `${event.systemPrompt}\n\n${injected}`,
    };
  });

  // Inject pending sandbox change notice into the last user message as content[0].
  // Also filter out UI-only sandbox change messages so they never reach the model.
  pi.on("context", async (event, ctx) => {
    refreshConfig(ctx);

    const filtered = (event.messages as any[]).filter(
      (m) => !(m?.role === "custom" && m?.customType === SANDBOX_CHANGE_MESSAGE_TYPE),
    );

    const pending = sessionState.pendingSandboxNotice;
    if (!pending) {
      if (filtered.length !== (event.messages as any[]).length) {
        return { messages: filtered as any };
      }
      return;
    }

    const nextMessages = injectSandboxNoticeIntoMessages(filtered as any[], pending.text);

    // Mark as communicated and clear pending.
    sessionState.lastCommunicatedHash = pending.hash;
    sessionState.pendingSandboxNotice = undefined;
    persistState();

    return { messages: nextMessages as any };
  });

 pi.registerCommand("sandbox", {
    description: "Configure sandbox and approval settings",
    handler: async (_args, ctx) => {
      refreshConfig(ctx);
      await showSandboxSettings(ctx);
    },
  });
}
