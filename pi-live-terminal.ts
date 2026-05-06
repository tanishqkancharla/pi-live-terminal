import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, Text, decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const CAPTURE_LINES = 200;
const VISIBLE_LINES = 16;
const POLL_MS = 500;
const CONTENT_PADDING = 1;
const WIDGET_ID = "pi-live-terminal";
const ENTRY_TYPE = "pi-live-terminal";
const DEFAULT_TITLE = "tmux";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type LiveTerminalAttachment = {
  target: string;
  title: string;
  sessionName?: string;
  command?: string;
  cwd?: string;
  state?: "running" | "completed";
  status?: string;
};

let currentAttachment: LiveTerminalAttachment | undefined;
let focusModalOpen = false;
const reportedExitTargets = new Set<string>();

function safeSessionName(input?: string): string {
  const base = (input || `pi-live-${randomBytes(4).toString("hex")}`)
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 64);
  return base || `pi-live-${randomBytes(4).toString("hex")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}…` : compact;
}

function startedMessage(sessionName: string): string {
  return `Started and attached to tmux session ${sessionName}.`;
}

function startedVisibleMessage(sessionName: string): string {
  return startedMessage(sessionName);
}

function attachmentName(attachment: LiveTerminalAttachment): string {
  return attachment.sessionName || attachment.title || attachment.target;
}

function statusGlyph(state: "running" | "completed" | "unknown", status?: string): string {
  if (state === "completed") return status === "0" ? "🟢" : "🔴";
  return SPINNER_FRAMES[Math.floor(Date.now() / POLL_MS) % SPINNER_FRAMES.length];
}

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function sendTmuxInput(target: string, data: string): Promise<string> {
  const printable = decodeKittyPrintable(data) ?? (isPrintableText(data) ? data : undefined);
  if (printable !== undefined) {
    return tmux(["send-keys", "-t", target, "-l", printable]);
  }

  const key = parseKey(data);
  const tmuxKey = key ? toTmuxKey(key) : undefined;
  if (tmuxKey) {
    return tmux(["send-keys", "-t", target, tmuxKey]);
  }

  return tmux(["send-keys", "-t", target, "-l", data]);
}

function isPrintableText(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && Array.from(data).every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

function toTmuxKey(key: string): string | undefined {
  const special: Record<string, string> = {
    escape: "Escape",
    esc: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    backspace: "BSpace",
    delete: "DC",
    insert: "IC",
    home: "Home",
    end: "End",
    pageUp: "PPage",
    pageDown: "NPage",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    f1: "F1",
    f2: "F2",
    f3: "F3",
    f4: "F4",
    f5: "F5",
    f6: "F6",
    f7: "F7",
    f8: "F8",
    f9: "F9",
    f10: "F10",
    f11: "F11",
    f12: "F12",
  };
  if (special[key]) return special[key];

  const parts = key.split("+");
  const base = parts.pop();
  if (!base) return undefined;
  const tmuxBase = special[base] || base;
  const modifiers = parts
    .map((part) => ({ ctrl: "C", shift: "S", alt: "M" })[part])
    .filter(Boolean);
  if (modifiers.length === 0) return undefined;
  return `${modifiers.join("-")}-${tmuxBase}`;
}

class LiveTerminalWidget implements Component {
  private lines: string[] = [];
  private error: string | undefined;
  private state: "running" | "completed" | "unknown" = "unknown";
  private exitStatus: string | undefined;
  private timer: NodeJS.Timeout;
  private scrollOffset = 0;
  private lastResize = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private target: string,
    private title: string = DEFAULT_TITLE,
    private onExit?: (status: string) => void,
  ) {
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const output = await tmux([
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        `-${CAPTURE_LINES}`,
        "-t",
        this.target,
      ]);
      const status = await tmux([
        "show-option",
        "-p",
        "-qv",
        "-t",
        this.target,
        "@pi_tmux_run_status",
      ]).catch(() => "");
      const exitStatus = status.trim();
      const wasCompleted = this.state === "completed";
      this.lines = output.replace(/\s+$/g, "").split("\n");
      this.error = undefined;
      this.exitStatus = exitStatus || undefined;
      this.state = exitStatus ? "completed" : "running";
      if (exitStatus && !wasCompleted) this.onExit?.(exitStatus);
      this.scrollOffset = Math.max(0, this.lines.length - VISIBLE_LINES);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const tmuxW = Math.max(1, innerW - CONTENT_PADDING * 2);
    const resizeKey = `${tmuxW}x${VISIBLE_LINES}`;
    if (resizeKey !== this.lastResize) {
      this.lastResize = resizeKey;
      void tmux([
        "resize-window",
        "-t",
        this.target,
        "-x",
        String(tmuxW),
        "-y",
        String(VISIBLE_LINES),
      ]).catch(() => {});
    }
    const border = (s: string) => th.fg("border", s);
    const shortcut = (s: string) => th.fg("muted", s);
    const muted = (s: string) => th.fg("muted", s);
    const dim = (s: string) => th.fg("dim", s);
    const pad = (s: string) =>
      truncateToWidth(s, innerW, "…", true).padEnd(
        Math.max(
          0,
          innerW -
            Math.max(0, visibleWidth(truncateToWidth(s, innerW, "…", true))),
        ),
      );
    const result: string[] = [];

    result.push("");
    const rawTitle = ` ${statusGlyph(this.state, this.exitStatus)} Live Terminal (${this.title}) `;
    const maxTitleWidth = Math.max(1, innerW - 1);
    const title = truncateToWidth(rawTitle, maxTitleWidth, "…");
    const rightRuleWidth = Math.max(0, innerW - 1 - visibleWidth(title));
    result.push(border("╭─") + title + border(`${"─".repeat(rightRuleWidth)}╮`));

    const body = this.error
      ? [th.fg("error", `tmux: ${this.error}`)]
      : this.lines;
    const visible = body.slice(
      this.scrollOffset,
      this.scrollOffset + VISIBLE_LINES,
    );
    for (const line of visible)
      result.push(border("│") + pad(`${" ".repeat(CONTENT_PADDING)}${line}`) + border("│"));
    for (let i = visible.length; i < VISIBLE_LINES; i++)
      result.push(border("│") + pad("") + border("│"));

    const hints = (this.state === "completed"
      ? [
          shortcut(" ctrl+shift+f ") + dim("focus"),
          shortcut(" ctrl+shift+v ") + dim("close"),
        ]
      : [
          shortcut(" ctrl+shift+f ") + dim("focus"),
          shortcut(" ctrl+shift+x ") + dim("kill"),
          shortcut(" ctrl+shift+v ") + dim("detach"),
        ]).join(border(" · "));
    const hintsWidth = visibleWidth(hints);
    const leftRuleWidth = Math.max(1, innerW - hintsWidth - 1);
    result.push(border("╰") + border("─".repeat(leftRuleWidth)) + hints + border("─╯"));
    return result;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

class TmuxFocusModal implements Component {
  private lines: string[] = [];
  private error: string | undefined;
  private state: "running" | "completed" | "unknown" = "unknown";
  private exitStatus: string | undefined;
  private timer: NodeJS.Timeout;
  private scrollOffset = 0;
  private lastResize = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private target: string,
    private title: string,
    private done: () => void,
    private onExit?: (status: string) => void,
  ) {
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
  }

  private visibleLines(): number {
    return Math.max(1, this.tui.terminal.rows - 2);
  }

  private async refresh(): Promise<void> {
    try {
      const output = await tmux([
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        `-${CAPTURE_LINES}`,
        "-t",
        this.target,
      ]);
      const status = await tmux([
        "show-option",
        "-p",
        "-qv",
        "-t",
        this.target,
        "@pi_tmux_run_status",
      ]).catch(() => "");
      const exitStatus = status.trim();
      const wasCompleted = this.state === "completed";
      this.lines = output.replace(/\s+$/g, "").split("\n");
      this.error = undefined;
      this.exitStatus = exitStatus || undefined;
      this.state = exitStatus ? "completed" : "running";
      if (exitStatus && !wasCompleted) this.onExit?.(exitStatus);
      this.scrollOffset = Math.max(0, this.lines.length - this.visibleLines());
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrlShift("f"))) {
      this.done();
      return;
    }

    void sendTmuxInput(this.target, data)
      .then(() => this.refresh())
      .catch((error) => {
        this.error = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const visibleLines = this.visibleLines();
    const tmuxW = Math.max(1, innerW - CONTENT_PADDING * 2);
    const resizeKey = `${tmuxW}x${visibleLines}`;
    if (resizeKey !== this.lastResize) {
      this.lastResize = resizeKey;
      void tmux([
        "resize-window",
        "-t",
        this.target,
        "-x",
        String(tmuxW),
        "-y",
        String(visibleLines),
      ]).catch(() => {});
    }

    const border = (s: string) => th.fg("borderAccent", s);
    const shortcut = (s: string) => th.fg("accent", s);
    const dim = (s: string) => th.fg("dim", s);
    const pad = (s: string) =>
      truncateToWidth(s, innerW, "…", true).padEnd(
        Math.max(
          0,
          innerW -
            Math.max(0, visibleWidth(truncateToWidth(s, innerW, "…", true))),
        ),
      );
    const result: string[] = [];

    const rawTitle = ` ${statusGlyph(this.state, this.exitStatus)} Live Terminal (${this.title}) `;
    const maxTitleWidth = Math.max(1, innerW - 1);
    const title = truncateToWidth(rawTitle, maxTitleWidth, "…");
    const rightRuleWidth = Math.max(0, innerW - 1 - visibleWidth(title));
    result.push(border("╭─") + title + border(`${"─".repeat(rightRuleWidth)}╮`));

    const body = this.error
      ? [th.fg("error", `tmux: ${this.error}`)]
      : this.lines;
    const visible = body.slice(
      this.scrollOffset,
      this.scrollOffset + visibleLines,
    );
    for (const line of visible)
      result.push(border("│") + pad(`${" ".repeat(CONTENT_PADDING)}${line}`) + border("│"));
    for (let i = visible.length; i < visibleLines; i++)
      result.push(border("│") + pad("") + border("│"));

    const hints = [
      shortcut(" ctrl+shift+f ") + dim("close focus"),
      dim("input is sent to tmux"),
    ].join(border(" · "));
    const hintsWidth = visibleWidth(hints);
    const leftRuleWidth = Math.max(1, innerW - hintsWidth - 1);
    result.push(border("╰") + border("─".repeat(leftRuleWidth)) + hints + border("─╯"));
    return result;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

export default function (pi: ExtensionAPI) {
  async function startLiveTerminal(
    ctx: { cwd?: string; hasUI?: boolean },
    command: string,
    options: { sessionName?: string; title?: string } = {},
  ) {
    const sessionName = safeSessionName(options.sessionName);
    const title = options.title || options.sessionName || compactText(command, 48) || DEFAULT_TITLE;
    const cwd = ctx.cwd || process.cwd();
    const wrappedCommand = `bash -lc ${shellQuote(`${command}
status=$?
printf '\n[Session exited with status %s]\n' "$status"
tmux set-option -p -t "$TMUX_PANE" @pi_tmux_run_status "$status" 2>/dev/null || true
sleep 300`)}`;

    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", cwd, wrappedCommand],
      {
        encoding: "utf8",
      },
    );

    const paneId = await tmux(["display-message", "-p", "-t", sessionName, "#{pane_id}"]);
    const target = paneId.trim() || sessionName;

    if (ctx.hasUI) {
      showWidget(ctx, { target, sessionName, title, command, cwd, state: "running" });
    }

    pi.appendEntry(ENTRY_TYPE, { action: "open", target, sessionName, title, command, cwd, state: "running", at: Date.now() });

    return { sessionName, target, title, command, cwd };
  }

  function reportProcessExit(ctx: any, attachment: LiveTerminalAttachment, status: string) {
    if (reportedExitTargets.has(attachment.target)) return;
    reportedExitTargets.add(attachment.target);

    const nextAttachment = currentAttachment?.target === attachment.target ? currentAttachment : attachment;
    nextAttachment.state = "completed";
    nextAttachment.status = status;

    pi.appendEntry(ENTRY_TYPE, {
      action: "exit",
      target: attachment.target,
      sessionName: attachment.sessionName,
      title: attachment.title,
      command: attachment.command,
      cwd: attachment.cwd,
      status,
      at: Date.now(),
    });
    ctx.ui.notify(`Session exited with status code ${status}: ${attachmentName(attachment)}`, "info");
  }

  function showWidget(ctx: any, attachment: LiveTerminalAttachment) {
    if (!ctx.hasUI) return;
    currentAttachment = attachment;
    ctx.ui.setWidget(
      WIDGET_ID,
      (tui: TUI, theme: Theme) => new LiveTerminalWidget(
        tui,
        theme,
        attachment.target,
        attachment.title,
        (status) => reportProcessExit(ctx, attachment, status),
      ),
      { placement: "aboveEditor" },
    );
  }

  async function killAttachmentSession(attachment: LiveTerminalAttachment) {
    if (!attachment.sessionName) {
      await tmux(["kill-pane", "-t", attachment.target]);
      return;
    }

    try {
      await tmux(["kill-session", "-t", attachment.sessionName]);
    } catch {
      await tmux(["kill-pane", "-t", attachment.target]);
    }
  }

  async function closeLiveTerminal(ctx: any, kill: boolean) {
    const attachment = currentAttachment;
    ctx.ui?.setWidget?.(WIDGET_ID, undefined);
    currentAttachment = undefined;

    if (!attachment) {
      const message = "No live terminal is attached.";
      ctx.ui?.notify?.(message, "info");
      return { message, killed: false };
    }

    pi.appendEntry(ENTRY_TYPE, {
      action: kill ? "kill" : "detach",
      target: attachment.target,
      sessionName: attachment.sessionName,
      at: Date.now(),
    });

    if (kill) {
      try {
        await killAttachmentSession(attachment);
        const message = `Closed live terminal and killed session ${attachmentName(attachment)}`;
        ctx.ui?.notify?.(message, "info");
        return { message, killed: true, sessionName: attachment.sessionName, target: attachment.target };
      } catch (error) {
        const message = `Closed live terminal widget, but failed to kill session ${attachmentName(attachment)}: ${error instanceof Error ? error.message : String(error)}`;
        ctx.ui?.notify?.(message, "warning");
        return { message, killed: false, sessionName: attachment.sessionName, target: attachment.target };
      }
    }

    const message = attachment.state === "completed"
      ? `Closed live terminal widget for completed session ${attachmentName(attachment)}`
      : `Detached live terminal widget from session ${attachmentName(attachment)}`;
    ctx.ui?.notify?.(message, "info");
    return { message, killed: false, sessionName: attachment.sessionName, target: attachment.target };
  }

  async function openFocusModal(ctx: any) {
    const attachment = currentAttachment;
    if (!attachment) {
      ctx.ui.notify("No Tmux widget is attached. Start one with live_terminal_run or /live-terminal:attach first.", "warning");
      return;
    }
    if (focusModalOpen) return;

    focusModalOpen = true;
    try {
      await ctx.ui.custom(
        (tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) =>
          new TmuxFocusModal(
            tui,
            theme,
            attachment.target,
            attachment.title,
            done,
            (status) => reportProcessExit(ctx, attachment, status),
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "100%",
            maxHeight: "100%",
            margin: 0,
          },
        },
      );
    } finally {
      focusModalOpen = false;
    }
  }

  async function detachWidget(ctx: { ui: { setWidget: Function; notify: Function } }, kill = false) {
    await closeLiveTerminal(ctx, kill);
  }

  pi.registerShortcut(Key.ctrlShift("x"), {
    description: "Detach the Tmux widget and kill its session",
    handler: (ctx) => detachWidget(ctx, true),
  });

  pi.registerShortcut(Key.ctrlShift("v"), {
    description: "Detach the Tmux widget without killing its session, or close it after completion",
    handler: (ctx) => detachWidget(ctx, false),
  });

  pi.registerShortcut(Key.ctrlShift("f"), {
    description: "Focus the Tmux session in a large interactive modal",
    handler: (ctx) => openFocusModal(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    let attachment: LiveTerminalAttachment | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as any;
      if (
        data?.action === "open" &&
        (typeof data.target === "string" || typeof data.sessionName === "string")
      ) {
        attachment = {
          target: data.target || data.paneId || data.sessionName,
          sessionName: typeof data.sessionName === "string" ? data.sessionName : undefined,
          title: typeof data.title === "string" ? data.title : DEFAULT_TITLE,
          command: typeof data.command === "string" ? data.command : undefined,
          cwd: typeof data.cwd === "string" ? data.cwd : undefined,
          state: data.state === "completed" ? "completed" : "running",
        };
      } else if (data?.action === "exit" && typeof data.target === "string") {
        reportedExitTargets.add(data.target);
        if (attachment?.target === data.target) {
          attachment.state = "completed";
          attachment.status = typeof data.status === "string" ? data.status : undefined;
        }
      } else if (data?.action === "detach" || data?.action === "kill" || data?.action === "close") {
        attachment = undefined;
      }
    }

    if (!attachment) return;
    try {
      await tmux(["display-message", "-p", "-t", attachment.target, "#{pane_id}"]);
      attachment.sessionName ||= (await tmux(["display-message", "-p", "-t", attachment.target, "#{session_name}"])).trim() || undefined;
      showWidget(ctx, attachment);
      ctx.ui.notify(`Reattached Tmux widget to session ${attachmentName(attachment)}`, "info");
    } catch {
      pi.appendEntry(ENTRY_TYPE, { action: "detach", target: attachment.target, reason: "tmux target missing", at: Date.now() });
    }
  });

  pi.registerCommand("live-terminal:focus", {
    description: "Focus the attached Tmux session in a large interactive modal",
    handler: async (_args, ctx) => {
      await openFocusModal(ctx);
    },
  });

  pi.registerCommand("live-terminal:run", {
    description: "Start a command in a live terminal and attach the widget",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) {
        ctx.ui.notify("Usage: /live-terminal:run <shell-command>", "warning");
        return;
      }

      try {
        const result = await startLiveTerminal(ctx, command);
        pi.sendMessage({
          customType: "live-terminal-status",
          content: `User started live terminal: session=${result.sessionName} command=${JSON.stringify(compactText(command, 300))}`,
          display: false,
          details: {
            startedBy: "user",
            sessionName: result.sessionName,
            title: result.title,
            cwd: result.cwd,
            command: compactText(command, 300),
          },
        }, { deliverAs: "nextTurn" });
        ctx.ui.notify(startedMessage(result.sessionName), "info");
      } catch (error) {
        ctx.ui.notify(`Could not start live terminal: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("live-terminal:close", {
    description: "Detach the live terminal widget and optionally kill its tmux session",
    handler: async (args, ctx) => {
      const shouldKill = args.trim() === "--kill" || args.trim() === "kill";
      await closeLiveTerminal(ctx, shouldKill);
    },
  });

  pi.registerCommand("live-terminal:attach", {
    description: "Attach the Pi Tmux widget to an existing tmux session target, e.g. my-session or my-session:0.0",
    handler: async (args, ctx) => {
      const [target, ...titleParts] = args.trim().split(/\s+/).filter(Boolean);
      if (!target) {
        ctx.ui.notify("Usage: /live-terminal:attach <session-target> [title]", "warning");
        return;
      }
      try {
        const paneId = (await tmux(["display-message", "-p", "-t", target, "#{pane_id}"])).trim();
        const sessionName = (await tmux(["display-message", "-p", "-t", target, "#{session_name}"])).trim() || undefined;
        const title = titleParts.join(" ") || target;
        const attachment = { target: paneId || target, sessionName, title, state: "running" as const };
        showWidget(ctx, attachment);
        pi.appendEntry(ENTRY_TYPE, { action: "open", target: paneId || target, sessionName, title, attachedExisting: true, at: Date.now() });
        ctx.ui.notify(`Attached Tmux widget to session ${attachmentName(attachment)}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not attach to tmux session ${target}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "live_terminal_run",
    label: "Run Live Terminal",
    description:
      "Start a command in a detached tmux session and show a live Tmux widget attached to it. Returns the tmux session id immediately.",
    promptSnippet:
      "live_terminal_run: run a command in a detached tmux session with a live Tmux widget visible to the user.",
    promptGuidelines: [
      "For interactive, TTY, full-screen, watch-mode, development-server, or long-running flows, use live_terminal_run instead of bash so the user can see and interact with the running process.",
      "When the session is no longer needed, use live_terminal_close to close the widget and kill the tmux session.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to run in the tmux session.",
      }),
      session_name: Type.Optional(
        Type.String({
          description:
            "Optional tmux session name. Defaults to pi-live-<random>.",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: "Short title to show in the widget border. Defaults to 'tmux'.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to the current Pi cwd.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await startLiveTerminal(
        { ...ctx, cwd: params.cwd || ctx.cwd },
        params.command,
        { sessionName: params.session_name, title: params.title || params.session_name || DEFAULT_TITLE },
      );

      return {
        content: [
          {
            type: "text",
            text: startedMessage(result.sessionName),
          },
        ],
        details: { sessionName: result.sessionName, command: params.command, cwd: result.cwd, visibleMessage: startedVisibleMessage(result.sessionName) },
      };
    },
    renderCall(args, theme) {
      const toolArgs = args as { command?: unknown };
      const command = typeof toolArgs.command === "string" ? toolArgs.command : "";
      const content = theme.fg("toolTitle", "live_terminal_run ") + theme.fg("dim", compactText(command, 160));
      return new Text(content, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { visibleMessage?: unknown; sessionName?: unknown } | undefined;
      const message = typeof details?.visibleMessage === "string"
        ? details.visibleMessage
        : typeof details?.sessionName === "string"
          ? startedVisibleMessage(details.sessionName)
          : "Started and attached to tmux session.";
      return new Text(theme.fg("success", message), 0, 0);
    },
  });

  pi.registerTool({
    name: "live_terminal_close",
    label: "Close Live Terminal",
    description:
      "Close the attached live terminal widget and kill its tmux session.",
    promptSnippet:
      "live_terminal_close: close the attached live terminal widget and kill its tmux session.",
    promptGuidelines: [
      "Use live_terminal_close when a live terminal session started with live_terminal_run is no longer needed.",
      "This closes the live pane and kills the attached tmux session; it does not merely detach the widget.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await closeLiveTerminal(ctx, true);
      return {
        content: [
          {
            type: "text",
            text: result.message,
          },
        ],
        details: result,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "live_terminal_close"), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { message?: unknown; killed?: unknown } | undefined;
      const message = typeof details?.message === "string" ? details.message : "Closed live terminal.";
      const color = details?.killed === false ? "warning" : "success";
      return new Text(theme.fg(color, message), 0, 0);
    },
  });
}
