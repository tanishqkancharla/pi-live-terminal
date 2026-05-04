import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const CAPTURE_LINES = 200;
const VISIBLE_LINES = 16;
const POLL_MS = 500;
const WIDGET_ID = "pi-live-terminal";
const ENTRY_TYPE = "pi-live-terminal";
const DEFAULT_TITLE = "tmux";

let currentAttachment: { target: string; title: string } | undefined;

function safeSessionName(input?: string): string {
  const base = (input || `pi-live-${randomBytes(4).toString("hex")}`)
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 64);
  return base || `pi-live-${randomBytes(4).toString("hex")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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

class LiveTerminalWidget implements Component {
  private lines: string[] = [];
  private error: string | undefined;
  private state: "running" | "completed" | "unknown" = "unknown";
  private timer: NodeJS.Timeout;
  private scrollOffset = 0;
  private lastResize = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private target: string,
    private title: string = DEFAULT_TITLE,
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
      this.lines = output.replace(/\s+$/g, "").split("\n");
      this.error = undefined;
      this.state = status.trim() ? "completed" : "running";
      this.scrollOffset = Math.max(0, this.lines.length - VISIBLE_LINES);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const resizeKey = `${innerW}x${VISIBLE_LINES}`;
    if (resizeKey !== this.lastResize) {
      this.lastResize = resizeKey;
      void tmux([
        "resize-window",
        "-t",
        this.target,
        "-x",
        String(innerW),
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
    const stateLabel = this.state === "completed" ? "completed" : "running";
    const rawTitle = ` Tmux (${this.title}) ${stateLabel} `;
    const maxTitleWidth = Math.max(1, innerW - 2);
    const title = rawTitle.length > maxTitleWidth ? `${rawTitle.slice(0, Math.max(0, maxTitleWidth - 1))}…` : rawTitle;
    const rightRuleWidth = Math.max(1, innerW - 1 - title.length);
    result.push(border(`╭─${title}${"─".repeat(rightRuleWidth)}╮`));

    const body = this.error
      ? [th.fg("error", `tmux: ${this.error}`)]
      : this.lines;
    const visible = body.slice(
      this.scrollOffset,
      this.scrollOffset + VISIBLE_LINES,
    );
    for (const line of visible)
      result.push(border("│") + pad(` ${line}`) + border("│"));
    for (let i = visible.length; i < VISIBLE_LINES; i++)
      result.push(border("│") + pad("") + border("│"));

    const hints = [
      shortcut(" ctrl+shift+x ") + dim("kill"),
      shortcut(" ctrl+shift+v ") + dim("unattach"),
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
  function showWidget(ctx: any, target: string, title: string = DEFAULT_TITLE) {
    if (!ctx.hasUI) return;
    currentAttachment = { target, title };
    ctx.ui.setWidget(
      WIDGET_ID,
      (tui: TUI, theme: Theme) => new LiveTerminalWidget(tui, theme, target, title),
      { placement: "aboveEditor" },
    );
  }

  async function detachWidget(ctx: { ui: { setWidget: Function; notify: Function } }, kill = false) {
    const attachment = currentAttachment;
    ctx.ui.setWidget(WIDGET_ID, undefined);
    currentAttachment = undefined;
    pi.appendEntry(ENTRY_TYPE, { action: kill ? "kill" : "detach", target: attachment?.target, at: Date.now() });
    if (kill && attachment?.target) {
      try {
        await tmux(["kill-pane", "-t", attachment.target]);
        ctx.ui.notify(`Unattached Tmux widget and killed pane ${attachment.target}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Unattached Tmux widget, but failed to kill pane ${attachment.target}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
      return;
    }
    ctx.ui.notify(attachment ? `Unattached Tmux widget from pane ${attachment.target}` : "Unattached Tmux widget.", "info");
  }

  pi.registerShortcut(Key.ctrlShift("x"), {
    description: "Unattach the Tmux widget and kill its pane",
    handler: (ctx) => detachWidget(ctx, true),
  });

  pi.registerShortcut(Key.ctrlShift("v"), {
    description: "Unattach the Tmux widget without killing its pane",
    handler: (ctx) => detachWidget(ctx, false),
  });

  pi.on("session_start", async (_event, ctx) => {
    let target: string | undefined;
    let title = DEFAULT_TITLE;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as any;
      if (
        data?.action === "open" &&
        (typeof data.target === "string" || typeof data.sessionName === "string")
      ) {
        target = data.target || data.paneId || data.sessionName;
        title = typeof data.title === "string" ? data.title : DEFAULT_TITLE;
      } else if (data?.action === "detach" || data?.action === "kill" || data?.action === "close") {
        target = undefined;
        title = DEFAULT_TITLE;
      }
    }

    if (!target) return;
    try {
      await tmux(["display-message", "-p", "-t", target, "#{pane_id}"]);
      showWidget(ctx, target, title);
      ctx.ui.notify(`Reattached Tmux widget to pane ${target}`, "info");
    } catch {
      pi.appendEntry(ENTRY_TYPE, { action: "detach", target, reason: "tmux pane missing", at: Date.now() });
    }
  });

  pi.registerCommand("live-terminal-close", {
    description: "Unattach the live terminal widget and optionally kill its tmux pane",
    handler: async (args, ctx) => {
      const shouldKill = args.trim() === "--kill" || args.trim() === "kill";
      const attachment = currentAttachment;
      ctx.ui.setWidget(WIDGET_ID, undefined);
      currentAttachment = undefined;
      pi.appendEntry(ENTRY_TYPE, { action: shouldKill ? "kill" : "detach", target: attachment?.target, at: Date.now() });

      if (shouldKill && attachment?.target) {
        try {
          await tmux(["kill-pane", "-t", attachment.target]);
          ctx.ui.notify(`Unattached live terminal and killed pane ${attachment.target}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `Closed live terminal widget, but failed to kill ${attachment.target}: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      } else {
        ctx.ui.notify(
          attachment
            ? `Unattached live terminal widget from pane ${attachment.target}`
            : "Unattached live terminal widget.",
          "info",
        );
      }
    },
  });

  pi.registerCommand("tmux-attach", {
    description: "Attach the Pi Tmux widget to an existing tmux pane target, e.g. %1 or session:window.pane",
    handler: async (args, ctx) => {
      const [target, ...titleParts] = args.trim().split(/\s+/).filter(Boolean);
      if (!target) {
        ctx.ui.notify("Usage: /tmux-attach <pane-target> [title]", "warning");
        return;
      }
      try {
        const paneId = (await tmux(["display-message", "-p", "-t", target, "#{pane_id}"])).trim();
        const title = titleParts.join(" ") || target;
        showWidget(ctx, paneId || target, title);
        pi.appendEntry(ENTRY_TYPE, { action: "open", target: paneId || target, title, attachedExisting: true, at: Date.now() });
        ctx.ui.notify(`Attached Tmux widget to pane ${paneId || target}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not attach to tmux pane ${target}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "tmux_run",
    label: "Tmux Run",
    description:
      "Start a command in a detached tmux session and show a live Tmux widget attached to it. Returns the tmux session id immediately.",
    promptSnippet:
      "tmux_run: run a command in a detached tmux session with a live Tmux widget visible to the user.",
    promptGuidelines: [
      "For interactive, TTY, full-screen, watch-mode, development-server, or long-running flows, use tmux_run instead of bash so the user can see and interact with the running process.",
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
      const sessionName = safeSessionName(params.session_name);
      const title = params.title || params.session_name || DEFAULT_TITLE;
      const cwd = params.cwd || ctx.cwd || process.cwd();
      const wrappedCommand = `bash -lc ${shellQuote(`${params.command}
status=$?
printf '\n[tmux_run exited with status %s]\n' "$status"
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
        showWidget(ctx, target, title);
      }

      pi.appendEntry(ENTRY_TYPE, { action: "open", target, sessionName, title, command: params.command, cwd, state: "running", at: Date.now() });

      return {
        content: [
          {
            type: "text",
            text: `Started tmux pane ${target} in session ${sessionName}\nAttach manually with: tmux attach -t ${sessionName}\nCommand: ${params.command}`,
          },
        ],
        details: { sessionName, pane: target, command: params.command, cwd },
      };
    },
  });
}
