// Ported from opencode-hooks-plugin (V1) to the OpenCode V2 plugin API.
//
// Runs Claude Code-style hooks configured in ~/.claude/settings.json and the
// project's .claude/settings(.local).json. Supported events: PreToolUse,
// PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, Stop,
// UserPromptSubmit. Notification and PreCompact have no OpenCode V2
// equivalent and are warned about, as in the original.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin, type Context } from "@opencode/plugin"

const LOG_PREFIX = "[opencode-hooks-api]";

type HookHandler =
  | { type: "command"; command: string; timeout?: number }
  | { type: "http"; url: string; headers?: Record<string, string>; timeout?: number }
  | { type: "prompt"; prompt: string; timeout?: number }
  | { type: "agent"; prompt: string; timeout?: number }
  | { type: string; [key: string]: unknown };

interface Matcher {
  matcher?: string;
  hooks: HookHandler[];
}

type HooksConfig = Record<string, Matcher[]>;

const UNSUPPORTED_EVENTS = [
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCompleted",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "Notification",
  "PreCompact",
];

function readSettingsFile(filePath: string): any {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function mergeHooksConfig(base: HooksConfig, override: HooksConfig): HooksConfig {
  const result: HooksConfig = { ...base };
  for (const [event, matchers] of Object.entries(override ?? {})) {
    const existing = result[event] ?? [];
    result[event] = [...existing, ...(matchers ?? [])];
  }
  return result;
}

function loadConfig(cwd: string, homeDir = homedir()) {
  const globalSettings = readSettingsFile(join(homeDir, ".claude", "settings.json"));
  const projectSettings = readSettingsFile(join(cwd, ".claude", "settings.json"));
  const localSettings = readSettingsFile(join(cwd, ".claude", "settings.local.json"));

  let merged: HooksConfig = {};
  if (globalSettings?.hooks) merged = mergeHooksConfig(merged, globalSettings.hooks);
  if (projectSettings?.hooks) merged = mergeHooksConfig(merged, projectSettings.hooks);
  if (localSettings?.hooks) merged = mergeHooksConfig(merged, localSettings.hooks);

  const disableAllHooks =
    localSettings?.disableAllHooks ?? projectSettings?.disableAllHooks ?? globalSettings?.disableAllHooks ?? false;

  return { hooks: merged, disableAllHooks };
}

function matchHook(matcher: string | undefined, value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher, "i").test(value);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function parseHookOutput(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

interface HookResult {
  action: "allow" | "block" | "error" | "skip";
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
}

function outputToResult(output: any): HookResult {
  if (!output) return { action: "allow" };
  if (output.decision === "block" || output.continue === false || output.ok === false) {
    return {
      action: "block",
      reason: output.stopReason ?? output.reason ?? "Blocked by hook",
      updatedInput: output.hookSpecificOutput?.updatedInput,
      additionalContext: output.hookSpecificOutput?.additionalContext,
    };
  }
  return {
    action: "allow",
    updatedInput: output.hookSpecificOutput?.updatedInput,
    additionalContext: output.hookSpecificOutput?.additionalContext,
  };
}

function interpolateEnvVars(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name: string) => process.env[name] ?? "");
}

async function runCommand(handler: any, input: unknown): Promise<HookResult> {
  const timeoutMs = (handler.timeout ?? 600) * 1000;
  const inputJson = JSON.stringify(input);
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn("bash", ["-c", handler.command], {
      env: {
        ...process.env,
        OPENCODE_PROJECT_DIR: (input as any)?.cwd,
        OPENCODE_SESSION_ID: (input as any)?.session_id,
        OPENCODE_HOOK_EVENT: (input as any)?.hook_event_name,
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolve({ action: "error", reason: `Command timed out after ${handler.timeout ?? 600}s` });
      }
    }, timeoutMs);
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      if (code === 0) {
        resolve(outputToResult(parseHookOutput(stdout)));
      } else if (code === 2) {
        resolve({ action: "block", reason: stderr || "Blocked by hook" });
      } else {
        const reason = stderr || `Command exited with code ${code}`;
        console.error(`${LOG_PREFIX} Command hook error (exit ${code}): ${reason}`);
        resolve({ action: "error", reason });
      }
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`${LOG_PREFIX} Failed to spawn command: ${err.message}`);
      resolve({ action: "error", reason: err.message });
    });
    proc.stdin?.write(inputJson, () => {
      proc.stdin?.end();
    });
  });
}

async function runHttp(handler: any, input: unknown): Promise<HookResult> {
  const timeoutMs = (handler.timeout ?? 600) * 1000;
  const body = JSON.stringify(input);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (handler.headers) {
    for (const [key, value] of Object.entries(handler.headers)) {
      headers[key] = interpolateEnvVars(String(value));
    }
  }
  try {
    const response = await fetch(handler.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const reason = `HTTP ${response.status} ${response.statusText}`;
      console.error(`${LOG_PREFIX} HTTP hook error: ${reason}`);
      return { action: "error", reason };
    }
    const text = await response.text();
    return outputToResult(parseHookOutput(text));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} HTTP hook fetch error: ${message}`);
    return { action: "error", reason: message };
  }
}

async function runPrompt(handler: any, input: unknown, ctx: Context): Promise<HookResult> {
  const timeoutMs = (handler.timeout ?? (handler.type === "agent" ? 60 : 30)) * 1000;
  const promptText = String(handler.prompt ?? "").replace(/\$ARGUMENTS/g, JSON.stringify(input));
  try {
    // Transient generation in a throwaway session, so hook prompts never
    // pollute the user's session history.
    const temp = await ctx.session.create({ title: "hooks-prompt-temp" });
    try {
      const result = await Promise.race([
        ctx.session.generate({ sessionID: temp.id, prompt: promptText }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Prompt hook timed out after ${timeoutMs / 1000}s`)), timeoutMs),
        ),
      ]);
      return outputToResult(parseHookOutput((result as { text?: string }).text ?? ""));
    } finally {
      await ctx.session.remove({ sessionID: temp.id }).catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Prompt/agent hook error: ${message}`);
    return { action: "error", reason: message };
  }
}

async function executeHook(handler: HookHandler, input: unknown, ctx: Context): Promise<HookResult> {
  switch (handler.type) {
    case "command":
      return runCommand(handler, input);
    case "http":
      return runHttp(handler, input);
    case "prompt":
    case "agent":
      return runPrompt(handler, input, ctx);
    default:
      return { action: "skip", reason: "Unknown handler type" };
  }
}

// ---------------------------------------------------------------------------
// Hook runner helpers
// ---------------------------------------------------------------------------

function findBlockResult(results: HookResult[]): HookResult | undefined {
  return results.find((r) => r.action === "block");
}

function findUpdatedInput(results: HookResult[]): unknown {
  for (const r of results) {
    if (r.updatedInput) return r.updatedInput;
  }
  return undefined;
}

function logAdditionalContext(results: HookResult[], eventName: string): void {
  for (const r of results) {
    if (r.additionalContext) {
      console.log(`${LOG_PREFIX} [${eventName}] additionalContext: ${r.additionalContext}`);
    }
  }
}

async function runHooksForEvent(
  eventName: string,
  matchers: Matcher[] | undefined,
  toolName: string | undefined,
  input: unknown,
  ctx: Context,
): Promise<HookResult[]> {
  if (!matchers || matchers.length === 0) return [];
  const promises: Promise<HookResult>[] = [];
  for (const matcher of matchers) {
    if (!matchHook(matcher.matcher, toolName)) continue;
    for (const handler of matcher.hooks) {
      promises.push(
        executeHook(handler, input, ctx).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`${LOG_PREFIX} Hook error (${eventName}):`, message);
          return { action: "error", reason: message };
        }),
      );
    }
  }
  return Promise.all(promises);
}

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}

function buildToolHookInput(eventName: string, tool: string, sessionID: string, input: unknown, cwd: string): HookInput {
  return {
    session_id: sessionID,
    cwd,
    hook_event_name: eventName,
    tool_name: tool,
    tool_input: input ?? {},
  };
}

function buildSessionHookInput(eventName: string, sessionId: string, cwd: string): HookInput {
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: eventName,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "claude-hooks",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const { hooks, disableAllHooks } = loadConfig(directory);
    if (disableAllHooks) {
      console.log(`${LOG_PREFIX} All hooks disabled (disableAllHooks=true)`);
      return;
    }
    for (const event of UNSUPPORTED_EVENTS) {
      if (hooks[event]?.length) {
        console.warn(
          `${LOG_PREFIX} Unsupported event "${event}" is configured but will not fire. Reason: no OpenCode V2 equivalent.`,
        );
      }
    }
    process.env.OPENCODE_PROJECT_DIR = directory;

    const registrations: { dispose(): Promise<void> }[] = [];

    // PreToolUse
    registrations.push(
      await ctx.tool.hook("execute.before", (event) => {
        const matchers = hooks["PreToolUse"];
        if (!matchers || matchers.length === 0) return;
        return (async () => {
          const hookInput = buildToolHookInput("PreToolUse", event.tool, event.sessionID, event.input, directory);
          process.env.OPENCODE_SESSION_ID = event.sessionID;
          process.env.OPENCODE_HOOK_EVENT = "PreToolUse";
          const results = await runHooksForEvent("PreToolUse", matchers, event.tool, hookInput, ctx);
          const block = findBlockResult(results);
          if (block) {
            throw new Error(block.reason ?? "Blocked by PreToolUse hook");
          }
          const updatedInput = findUpdatedInput(results);
          if (updatedInput && typeof updatedInput === "object" && typeof event.input === "object" && event.input) {
            Object.assign(event.input as Record<string, unknown>, updatedInput as Record<string, unknown>);
          }
          logAdditionalContext(results, "PreToolUse");
        })();
      }),
    );

    // PostToolUse / PostToolUseFailure
    registrations.push(
      await ctx.tool.hook("execute.after", (event) => {
        const eventName = event.status === "error" ? "PostToolUseFailure" : "PostToolUse";
        const matchers = hooks[eventName];
        if (!matchers || matchers.length === 0) return;
        return (async () => {
          const output =
            event.status === "completed" ? (event.result as unknown) : (event as { error?: unknown }).error;
          const hookInput = {
            ...buildToolHookInput(eventName, event.tool, event.sessionID, event.input, directory),
            tool_output: typeof output === "string" ? output : JSON.stringify(output ?? ""),
            tool_error: event.status === "error",
          };
          process.env.OPENCODE_SESSION_ID = event.sessionID;
          process.env.OPENCODE_HOOK_EVENT = eventName;
          const results = await runHooksForEvent(eventName, matchers, event.tool, hookInput, ctx);
          const block = findBlockResult(results);
          if (block) {
            console.log(`${LOG_PREFIX} [${eventName}] Hook requested block: ${block.reason ?? "no reason"}`);
          }
          logAdditionalContext(results, eventName);
        })();
      }),
    );

    // UserPromptSubmit: side effects only; V2 prompt hooks cannot reject admission.
    registrations.push(
      await ctx.session.hook("prompt", (event) => {
        const matchers = hooks["UserPromptSubmit"];
        if (!matchers || matchers.length === 0) return;
        return (async () => {
          const hookInput: HookInput = {
            session_id: event.sessionID,
            cwd: directory,
            hook_event_name: "UserPromptSubmit",
          };
          process.env.OPENCODE_SESSION_ID = event.sessionID;
          process.env.OPENCODE_HOOK_EVENT = "UserPromptSubmit";
          const results = await runHooksForEvent("UserPromptSubmit", matchers, undefined, hookInput, ctx);
          const block = findBlockResult(results);
          if (block) {
            console.log(`${LOG_PREFIX} [UserPromptSubmit] Hook requested block: ${block.reason ?? "no reason"}`);
          }
          logAdditionalContext(results, "UserPromptSubmit");
        })();
      }),
    );

    // Session lifecycle events
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
        types: ["session.created", "session.deleted", "session.idle"],
      })) {
        try {
          const sessionId = (event.data as { sessionID?: string } | undefined)?.sessionID;
          if (!sessionId) continue;
          let eventName: string | undefined;
          if (event.type === "session.created") eventName = "SessionStart";
          else if (event.type === "session.deleted") eventName = "SessionEnd";
          else if (event.type === "session.idle") eventName = "Stop";
          if (!eventName) continue;
          const matchers = hooks[eventName];
          if (!matchers || matchers.length === 0) continue;
          const hookInput = buildSessionHookInput(eventName, sessionId, directory);
          process.env.OPENCODE_SESSION_ID = sessionId;
          process.env.OPENCODE_HOOK_EVENT = eventName;
          const results = await runHooksForEvent(eventName, matchers, undefined, hookInput, ctx);
          const block = findBlockResult(results);
          if (block) {
            console.log(`${LOG_PREFIX} [${eventName}] Hook requested block: ${block.reason ?? "no reason"}`);
          }
          logAdditionalContext(results, eventName);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`${LOG_PREFIX} Unhandled error in event handler (${event.type}):`, message);
        }
      }
    })();

    return () => {
      controller.abort();
      for (const registration of registrations) {
        void registration.dispose();
      }
    };
  },
});
