// Ported from opencode-notify (V1) to the OpenCode V2 plugin API.
//
// Native OS notifications with actionable buttons when OpenCode needs
// attention: permission requests, questions (forms), errors, and optional
// idle notifications. On Windows the primary backend is `powertoast` when
// installed; otherwise a dependency-free PowerShell WinRT toast is used
// (no action buttons, sound only). Config: ~/.config/opencode/opencode-notify.json
import { execSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin, type Context } from "@opencode/plugin"

const LOG_FILE = join(homedir(), ".opencode-notify.log");
function log(message: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

interface NotifyConfig {
  sounds: { permission: string; error: string };
  quietHours: { enabled: boolean; start: string; end: string };
  notifyChildSessions: boolean;
  terminal: string | null;
  focusAfterAction: boolean;
  notifyOnIdle: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = {
  sounds: { permission: "Submarine", error: "Basso" },
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  notifyChildSessions: false,
  terminal: null,
  focusAfterAction: true,
  notifyOnIdle: false,
};

function loadConfig(): NotifyConfig {
  const configPath = join(homedir(), ".config", "opencode", "opencode-notify.json");
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const userConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      sounds: { ...DEFAULT_CONFIG.sounds, ...(userConfig.sounds ?? {}) },
      quietHours: { ...DEFAULT_CONFIG.quietHours, ...(userConfig.quietHours ?? {}) },
    };
  } catch {
    console.warn("[opencode-notify] Failed to parse config, using defaults");
    return DEFAULT_CONFIG;
  }
}

function parseTime(time: string): { hours: number; minutes: number } {
  const [hours, minutes] = time.split(":").map(Number);
  return { hours, minutes };
}

function isQuietHours(config: NotifyConfig): boolean {
  if (!config.quietHours.enabled) return false;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(config.quietHours.start);
  const end = parseTime(config.quietHours.end);
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ---------------------------------------------------------------------------
// Terminal detection and focus
// ---------------------------------------------------------------------------

interface TerminalInfo {
  app: string;
  bundleId?: string;
  processName?: string;
}

function detectTerminal(configuredTerminal: string | null): TerminalInfo {
  if (configuredTerminal) {
    const lowered = configuredTerminal.toLowerCase();
    const terminals: Record<string, TerminalInfo> = {
      ghostty: { app: "ghostty", bundleId: "com.mitchellh.ghostty", processName: "ghostty" },
      kitty: { app: "kitty", bundleId: "net.kovidgoyal.kitty", processName: "kitty" },
      iterm: { app: "iterm", bundleId: "com.googlecode.iterm2", processName: "iTerm2" },
      iterm2: { app: "iterm", bundleId: "com.googlecode.iterm2", processName: "iTerm2" },
      wezterm: { app: "wezterm", bundleId: "com.github.wez.wezterm", processName: "wezterm-gui" },
      terminal: { app: "terminal", bundleId: "com.apple.Terminal", processName: "Terminal" },
      alacritty: { app: "alacritty", bundleId: "org.alacritty", processName: "Alacritty" },
      hyper: { app: "hyper", bundleId: "co.zeit.hyper", processName: "Hyper" },
      "windows-terminal": { app: "windows-terminal", processName: "WindowsTerminal" },
    };
    return terminals[lowered] ?? { app: "unknown" };
  }
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
  const lcTerminal = process.env.LC_TERMINAL?.toLowerCase();
  if (termProgram === "ghostty" || lcTerminal === "ghostty") {
    return { app: "ghostty", bundleId: "com.mitchellh.ghostty", processName: "ghostty" };
  }
  if (termProgram === "iterm.app") {
    return { app: "iterm", bundleId: "com.googlecode.iterm2", processName: "iTerm2" };
  }
  if (termProgram === "wezterm") {
    return { app: "wezterm", bundleId: "com.github.wez.wezterm", processName: "wezterm-gui" };
  }
  if (termProgram === "apple_terminal") {
    return { app: "terminal", bundleId: "com.apple.Terminal", processName: "Terminal" };
  }
  if (process.env.KITTY_WINDOW_ID) {
    return { app: "kitty", bundleId: "net.kovidgoyal.kitty", processName: "kitty" };
  }
  if (termProgram === "alacritty") {
    return { app: "alacritty", bundleId: "org.alacritty", processName: "Alacritty" };
  }
  if (termProgram === "hyper") {
    return { app: "hyper", bundleId: "co.zeit.hyper", processName: "Hyper" };
  }
  if (process.env.WT_SESSION) {
    return { app: "windows-terminal", processName: "WindowsTerminal" };
  }
  return { app: "unknown" };
}

function isWindowsAppFocused(processName: string | undefined): boolean {
  if (!processName) return false;
  try {
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32Focus {
          [DllImport("user32.dll")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")]
          public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        }
"@
      $hwnd = [Win32Focus]::GetForegroundWindow()
      $procId = 0
      [void][Win32Focus]::GetWindowThreadProcessId($hwnd, [ref]$procId)
      (Get-Process -Id $procId).ProcessName
    `;
    const result = execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return result.toLowerCase().includes(processName.toLowerCase());
  } catch {
    return false;
  }
}

function isTerminalFocused(terminal: TerminalInfo): boolean {
  const platform = process.platform;
  if (platform === "win32") return isWindowsAppFocused(terminal.processName);
  // macOS/Linux focus checks from the original are best-effort; the OpenCode
  // server usually runs headless on those platforms.
  return false;
}

function focusTerminal(terminal: TerminalInfo): void {
  const platform = process.platform;
  if (platform === "win32" && terminal.processName) {
    try {
      execSync(
        `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate('${terminal.processName}')"`,
        { timeout: 2000 },
      );
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Notifier backends
// ---------------------------------------------------------------------------

interface NotifyOptions {
  title: string;
  subtitle?: string;
  message: string;
  sound?: string;
  actions?: string[];
}

interface Notifier {
  notify(options: NotifyOptions): Promise<{ action: string; activated: boolean }>;
}

interface PowerToastModule {
  Toast: new (options: any) => any;
}

/** Primary Windows backend: powertoast, with actionable toast buttons. */
class PowerToastNotifier implements Notifier {
  private toast: PowerToastModule["Toast"] | null = null;

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      const mod = (await import("powertoast")) as unknown as PowerToastModule;
      this.toast = mod.Toast;
      return this.toast !== undefined;
    } catch {
      return false;
    }
  }

  mapSoundToWindows(macSound: string | undefined): string {
    const soundMap: Record<string, string> = {
      Submarine: "ms-winsoundevent:Notification.Default",
      Glass: "ms-winsoundevent:Notification.IM",
      Basso: "ms-winsoundevent:Notification.Reminder",
      Ping: "ms-winsoundevent:Notification.Mail",
      Pop: "ms-winsoundevent:Notification.SMS",
    };
    return soundMap[macSound ?? ""] ?? "ms-winsoundevent:Notification.Default";
  }

  notify(options: NotifyOptions): Promise<{ action: string; activated: boolean }> {
    if (!this.toast) return Promise.resolve({ action: "dismissed", activated: false });
    return new Promise((resolve) => {
      const toast = new this.toast!({
        title: options.title,
        message: options.message,
        appId: "com.opencode.notify",
        actions: options.actions?.map((label) => ({ content: label, arguments: label.toLowerCase() })),
        audio: options.sound !== undefined ? { src: this.mapSoundToWindows(options.sound) } : undefined,
      });
      toast.on("activated", (event: any) => {
        const action = (event?.arguments ?? "accept").toString().toLowerCase();
        const normalised = ["accept", "always", "reject", "dismiss"].includes(action) ? action : action;
        resolve({ action: normalised, activated: true });
      });
      toast.on("dismissed", () => resolve({ action: "dismissed", activated: false }));
      toast.show().catch(() => resolve({ action: "dismissed", activated: false }));
    });
  }
}

/** Fallback Windows backend: raw WinRT toast via PowerShell (sound only). */
class PowerShellToastNotifier implements Notifier {
  private escape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  mapSoundToWindows(macSound: string | undefined): string {
    const soundMap: Record<string, string> = {
      Submarine: "ms-winsoundevent:Notification.Default",
      Glass: "ms-winsoundevent:Notification.IM",
      Basso: "ms-winsoundevent:Notification.Reminder",
      Ping: "ms-winsoundevent:Notification.Mail",
      Pop: "ms-winsoundevent:Notification.SMS",
    };
    return soundMap[macSound ?? ""] ?? "ms-winsoundevent:Notification.Default";
  }

  async notify(options: NotifyOptions): Promise<{ action: string; activated: boolean }> {
    if (process.platform !== "win32") return { action: "dismissed", activated: false };
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xmlText = @"
<toast activationType="protocol" launch="opencode:">
  <visual>
    <binding template="ToastGeneric">
      <text>${this.escape(options.title)}</text>
      <text>${this.escape(options.message)}</text>
    </binding>
  </visual>
  <audio src="${this.mapSoundToWindows(options.sound)}" />
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("OpenCode.Notify").Show($toast)
`;
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch (err) {
      log(`PowerShell toast failed: ${err instanceof Error ? err.message : String(err)}`);
      // Last resort: play a system sound only.
      try {
        execSync(
          `powershell -NoProfile -Command "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify.wav').PlaySync()"`,
          { timeout: 3000, stdio: "ignore" },
        );
      } catch {}
    }
    return { action: "dismissed", activated: false };
  }
}

class NotificationDispatcher {
  private notifier: Notifier | null = null;
  private initialised = false;

  async initialise(config: NotifyConfig): Promise<boolean> {
    if (this.initialised) return this.notifier !== null;
    this.initialised = true;
    if (process.platform === "win32") {
      const powerToast = new PowerToastNotifier();
      if (await powerToast.isAvailable()) {
        this.notifier = powerToast;
        return true;
      }
      this.notifier = new PowerShellToastNotifier();
      return true;
    }
    console.warn(`[opencode-notify] No notification backend available for platform: ${process.platform}`);
    return false;
  }

  async notify(options: NotifyOptions): Promise<{ action: string; activated: boolean }> {
    if (!this.notifier) {
      const available = await this.initialise(loadConfig());
      if (!available || !this.notifier) return { action: "dismissed", activated: false };
    }
    return this.notifier.notify(options);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "notify",
  async setup(ctx: Context) {
    const config = loadConfig();
    const terminal = detectTerminal(config.terminal);
    const dispatcher = new NotificationDispatcher();
    const isShowingNotification = { value: false };
    let hasNotifiedIdle = false;

    const available = await dispatcher.initialise(config);
    if (!available) log("No notification backend available for this platform.");
    log("Initialised (OpenCode V2 port)");

    const shouldSuppress = (): boolean => isQuietHours(config);

    async function maybeReplyPermission(
      decision: "once" | "always" | "reject",
      sessionID: string,
      ctx: Context,
    ): Promise<void> {
      try {
        const pending = await ctx.permission.list({ sessionID });
        const first = Array.isArray(pending) ? pending[0] : undefined;
        if (!first) return;
        await ctx.permission.reply({ sessionID, requestID: first.id, decision });
      } catch (err) {
        log(`Error replying to permission: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    async function showPermission(
      action: string,
      resources: string[],
      sessionID: string,
      ctx: Context,
    ): Promise<void> {
      if (shouldSuppress() || isTerminalFocused(terminal) || isShowingNotification.value) return;
      const message = resources.join(", ") || action || "Permission requested";
      log(`Showing permission notification: ${action} - ${message}`);
      isShowingNotification.value = true;
      try {
        const result = await dispatcher.notify({
          title: "Opencode Permission Request",
          subtitle: action,
          message: message.length > 100 ? message.slice(0, 100) + "…" : message,
          sound: config.sounds.permission,
          actions: ["Accept", "Always", "Reject"],
        });
        log(`Permission result: action=${result.action}, activated=${result.activated}`);
        const lowered = result.action.toLowerCase();
        if (result.activated) {
          if (lowered === "accept") await maybeReplyPermission("once", sessionID, ctx);
          else if (lowered === "always") await maybeReplyPermission("always", sessionID, ctx);
          else if (lowered === "reject") await maybeReplyPermission("reject", sessionID, ctx);
          if (config.focusAfterAction && ["accept", "always"].includes(lowered)) focusTerminal(terminal);
        }
      } catch (err) {
        log(`Error showing notification: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        isShowingNotification.value = false;
      }
    }

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
        types: [
          "permission.asked",
          "form.created",
          "session.execution.failed",
          "session.step.failed",
          "session.idle",
        ],
      })) {
        try {
          const data = (event as { data?: Record<string, unknown> }).data ?? {};
          switch (event.type) {
            case "permission.asked": {
              hasNotifiedIdle = false;
              await showPermission(
                String(data.action ?? "Permission"),
                (data.resources as string[] | undefined) ?? [],
                String(data.sessionID ?? ""),
                ctx,
              );
              break;
            }
            case "form.created": {
              hasNotifiedIdle = false;
              if (shouldSuppress() || isTerminalFocused(terminal) || isShowingNotification.value) break;
              const form = data.form as { sessionID?: string; title?: string } | undefined;
              const message = form?.title || "Opencode has a question for you";
              log(`Showing question notification: ${message.slice(0, 50)}...`);
              isShowingNotification.value = true;
              try {
                const result = await dispatcher.notify({
                  title: "Opencode Question",
                  message,
                  sound: config.sounds.permission,
                  actions: ["View", "Dismiss"],
                });
                if (
                  result.activated &&
                  config.focusAfterAction &&
                  result.action.toLowerCase() !== "dismiss"
                ) {
                  focusTerminal(terminal);
                }
              } finally {
                isShowingNotification.value = false;
              }
              break;
            }
            case "session.execution.failed":
            case "session.step.failed": {
              if (shouldSuppress() || isTerminalFocused(terminal)) break;
              const error = data.error as { message?: string } | undefined;
              const message = error?.message ?? "An error occurred";
              await dispatcher.notify({
                title: "Opencode Error",
                message,
                sound: config.sounds.error,
              });
              break;
            }
            case "session.idle": {
              if (!config.notifyOnIdle || hasNotifiedIdle) break;
              if (shouldSuppress() || isTerminalFocused(terminal)) break;
              hasNotifiedIdle = true;
              await dispatcher.notify({
                title: "Opencode",
                message: "Agent has stopped and is waiting for input",
                sound: config.sounds.permission,
              });
              break;
            }
          }
        } catch (err) {
          log(`Unhandled error in event handler (${event.type}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    return () => controller.abort();
  },
});
