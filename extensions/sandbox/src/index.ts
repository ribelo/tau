import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

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
import type { ApprovalPolicy, FilesystemMode, NetworkMode, SandboxConfig } from "./config.js";
import { computeEffectiveConfig, ensureUserDefaults } from "./config.js";
import { checkWriteAllowed } from "./fs-policy.js";
import { wrapCommandWithSandbox, isAsrtAvailable } from "./sandbox-bash.js";
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
};

function loadSessionOverride(ctx: ExtensionContext): SandboxConfig | undefined {
  const entries = ctx.sessionManager.getBranch();
  let last: SessionState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      last = entry.data as SessionState | undefined;
    }
  }
  return last?.override ? { ...last.override } : undefined;
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

  // First-run: ensure sandbox defaults are written into ~/.pi/agent/settings.json (only fills missing keys).
  ensureUserDefaults();

  let workspaceRoot = process.cwd();
  let sessionOverride: SandboxConfig | undefined;
  let effectiveConfig = computeEffectiveConfig({
    workspaceRoot,
    sessionOverride,
  });
  let cliOverride: SandboxConfig | undefined;

  function refreshConfig(ctx: ExtensionContext) {
    workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
    sessionOverride = loadSessionOverride(ctx);
    // Merge CLI override with session override (CLI takes precedence)
    const mergedOverride = { ...sessionOverride, ...cliOverride };
    effectiveConfig = computeEffectiveConfig({
      workspaceRoot,
      sessionOverride: mergedOverride,
    });
  }

  function persistState() {
    pi.appendEntry<SessionState>(STATE_TYPE, { override: sessionOverride });
  }

  function setOverrideValue<K extends keyof SandboxConfig>(
    key: K,
    value: SandboxConfig[K] | undefined,
  ) {
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
 }

  const baseBashTool = createBashTool(process.cwd());
  const baseEditTool = createEditTool(process.cwd());
  const baseWriteTool = createWriteTool(process.cwd());

  // Factory to create sandboxed bash operations with captured context (avoids global state race conditions)
  function createSandboxedBashOperations(ctx: ExtensionContext, escalate: boolean): BashOperations {
    return {
      async exec(command, cwd, { onData, signal, timeout }) {
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

        // Try to wrap with ASRT
        const wrapResult = await wrapCommandWithSandbox({
          command,
          workspaceRoot: currentWorkspace,
          filesystemMode: currentConfig.filesystemMode,
          networkMode: currentConfig.networkMode,
          networkAllowlist: currentConfig.networkAllowlist,
        });

        let finalCommand: string;
        let env = { ...process.env };
        let usingSandbox = false;

        if (wrapResult.success) {
          finalCommand = wrapResult.wrappedCommand;
          env.HOME = wrapResult.home;
          usingSandbox = true;
        } else {
          // ASRT not available - fall back to unsandboxed with warning
          console.error(`[sandbox] ASRT unavailable: ${wrapResult.error}`);
          finalCommand = command;
        }

        // Run the command (sandboxed if possible)
        const result = await runCommandCapture(
          finalCommand,
          cwd,
          env as Record<string, string>,
          { onData, signal, timeout },
        );

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
        };
        const mapped = netMap[sandboxNet.toLowerCase()];
        if (mapped) {
          cliOverride.networkMode = mapped;
          ctx.ui.notify(`Sandbox network mode: ${mapped}`, "info");
        } else {
          ctx.ui.notify(
            `Invalid --sandbox-net value: ${sandboxNet}. Use: deny, allow`,
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

 pi.registerCommand("sandbox", {
    description: "Configure sandbox and approval settings",
    handler: async (_args, ctx) => {
      refreshConfig(ctx);
      await showSandboxSettings(ctx);
    },
  });
}
