import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, Text, decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import type { ReadStream } from "node:fs";

const CAPTURE_LINES = 200;
const VISIBLE_LINES = 16;
const POLL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const CONTENT_PADDING = 1;
const WHEEL_SCROLL_LINES = 3;
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

type WaitForOptions = {
  regex?: string;
  event?: "exit" | "target_closed";
  ignore_case?: boolean;
  timeout_ms?: number;
  poll_ms?: number;
};

type WaitCondition =
  | { kind: "regex"; regex: RegExp; source: string }
  | { kind: "event"; event: "exit" | "target_closed" };

type WaitResult = {
  matched: boolean;
  timedOut?: boolean;
  condition: string;
  elapsedMs: number;
  status?: string;
  match?: string;
};

type PaneSubscriber = (chunk: string) => void;

type PaneStream = {
  target: string;
  fifoPath: string;
  stream: ReadStream;
  subscribers: Set<PaneSubscriber>;
};

let currentAttachment: LiveTerminalAttachment | undefined;
let focusModalOpen = false;
const reportedExitTargets = new Set<string>();
let mouseReportingRefCount = 0;
const paneStreams = new Map<string, PaneStream>();
const paneStreamCreates = new Map<string, Promise<PaneStream>>();

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

function attachedMessage(sessionName: string | undefined, target: string): string {
  return `Attached to tmux session ${sessionName || target}.`;
}

function attachmentName(attachment: LiveTerminalAttachment): string {
  return attachment.sessionName || attachment.title || attachment.target;
}

function statusGlyph(state: "running" | "completed" | "unknown", status?: string): string {
  if (state === "completed") return status === "0" ? "🟢" : "🔴";
  return SPINNER_FRAMES[Math.floor(Date.now() / POLL_MS) % SPINNER_FRAMES.length];
}

function waitDescription(condition: WaitCondition): string {
  return condition.kind === "regex"
    ? `regex ${JSON.stringify(condition.source)}`
    : `event ${condition.event}`;
}

function waitResultMessage(result: WaitResult): string {
  if (result.timedOut) return `Timed out after ${result.elapsedMs}ms waiting for ${result.condition}.`;
  if (result.status !== undefined) return `Matched ${result.condition} with status ${result.status} after ${result.elapsedMs}ms.`;
  if (result.match !== undefined) return `Matched ${result.condition} after ${result.elapsedMs}ms: ${compactText(result.match, 120)}`;
  return `Matched ${result.condition} after ${result.elapsedMs}ms.`;
}

function waitForRenderSummary(waitFor: unknown): string | undefined {
  if (!waitFor || typeof waitFor !== "object") return undefined;
  const value = waitFor as { regex?: unknown; event?: unknown; ignore_case?: unknown };
  if (typeof value.regex === "string") {
    const flags = value.ignore_case ? "im" : "m";
    return `/${value.regex}/${flags}`;
  }
  if (typeof value.event === "string") return `event:${value.event}`;
  return undefined;
}

function positiveNumber(value: number | undefined, defaultValue: number, name: string): number {
  const result = value ?? defaultValue;
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive number.`);
  return result;
}

function parseWaitFor(waitFor: WaitForOptions): { condition: WaitCondition; timeoutMs: number; pollMs: number } {
  const hasRegex = typeof waitFor.regex === "string" && waitFor.regex.length > 0;
  const hasEvent = typeof waitFor.event === "string";
  if (hasRegex === hasEvent) throw new Error("wait_for must include exactly one of regex or event.");

  const timeoutMs = positiveNumber(waitFor.timeout_ms, DEFAULT_WAIT_TIMEOUT_MS, "wait_for.timeout_ms");
  const pollMs = positiveNumber(waitFor.poll_ms, POLL_MS, "wait_for.poll_ms");

  if (hasEvent) {
    if (waitFor.event !== "exit" && waitFor.event !== "target_closed") {
      throw new Error("wait_for.event must be 'exit' or 'target_closed'.");
    }
    return { condition: { kind: "event", event: waitFor.event }, timeoutMs, pollMs };
  }

  try {
    const flags = waitFor.ignore_case ? "im" : "m";
    return { condition: { kind: "regex", regex: new RegExp(waitFor.regex!, flags), source: waitFor.regex! }, timeoutMs, pollMs };
  } catch (error) {
    throw new Error(`Invalid wait_for.regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Wait aborted."));
      return;
    }

    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Wait aborted."));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function enableMouseReporting(): void {
  if (!process.stdout.isTTY) return;
  if (mouseReportingRefCount++ === 0) {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  }
}

function disableMouseReporting(): void {
  if (!process.stdout.isTTY || mouseReportingRefCount === 0) return;
  mouseReportingRefCount--;
  if (mouseReportingRefCount === 0) {
    process.stdout.write("\x1b[?1006l\x1b[?1000l");
  }
}

function parseSgrMouse(data: string): { button: number; x: number; y: number } | undefined {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/);
  if (!match) return undefined;
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
  };
}

function wheelScrollDelta(data: string): number | undefined {
  const mouse = parseSgrMouse(data);
  if (!mouse || (mouse.button & 64) === 0) return undefined;

  const wheelButton = mouse.button & 3;
  if (wheelButton === 0) return -WHEEL_SCROLL_LINES;
  if (wheelButton === 1) return WHEEL_SCROLL_LINES;
  return undefined;
}

function maxScrollOffset(lineCount: number, visibleLines: number): number {
  return Math.max(0, lineCount - visibleLines);
}

function clampScrollOffset(offset: number, lineCount: number, visibleLines: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(lineCount, visibleLines));
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

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function createPaneStream(target: string): Promise<PaneStream> {
  try {
    const fifoPath = `/tmp/pi-live-terminal-${process.pid}-${randomBytes(6).toString("hex")}.fifo`;
    await runCommand("mkfifo", [fifoPath]);

    const stream = createReadStream(fifoPath, { encoding: "utf8" });
    const paneStream: PaneStream = {
      target,
      fifoPath,
      stream,
      subscribers: new Set(),
    };

    stream.on("data", (chunk) => {
      for (const subscriber of paneStream.subscribers) subscriber(chunk);
    });

    stream.on("error", () => {
      void closePaneStream(target).catch(() => {});
    });

    try {
      await tmux(["pipe-pane", "-O", "-t", target, `cat > ${shellQuote(fifoPath)}`]);
    } catch (error) {
      stream.destroy();
      await fs.unlink(fifoPath).catch(() => {});
      throw error;
    }

    paneStreams.set(target, paneStream);
    paneStreamCreates.delete(target);
    return paneStream;
  } catch (error) {
    paneStreamCreates.delete(target);
    throw error;
  }
}

async function closePaneStream(target: string): Promise<void> {
  const paneStream = paneStreams.get(target);
  if (!paneStream) return;

  paneStreams.delete(target);
  paneStreamCreates.delete(target);
  await tmux(["pipe-pane", "-t", target]).catch(() => {});
  paneStream.stream.destroy();
  await fs.unlink(paneStream.fifoPath).catch(() => {});
}

async function subscribePaneOutput(target: string, subscriber: PaneSubscriber): Promise<() => Promise<void>> {
  let paneStream = paneStreams.get(target);
  if (!paneStream) {
    const pending = paneStreamCreates.get(target) ?? createPaneStream(target);
    paneStreamCreates.set(target, pending);
    paneStream = await pending;
  }
  paneStream.subscribers.add(subscriber);

  return async () => {
    const active = paneStreams.get(target);
    if (!active) return;
    active.subscribers.delete(subscriber);
    if (active.subscribers.size === 0) {
      await closePaneStream(target);
    }
  };
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

async function getTmuxTargetInfo(target: string): Promise<{ target: string; sessionName?: string }> {
  const output = await tmux(["list-panes", "-t", target, "-F", "#{pane_id}\t#{session_name}"]);
  const [paneId, sessionName] = output.trim().split("\n")[0]?.split("\t") ?? [];
  if (!paneId) throw new Error(`Could not resolve tmux target ${target}.`);
  return { target: paneId, sessionName: sessionName || undefined };
}

async function tmuxTargetExists(target: string): Promise<boolean> {
  if (target.startsWith("%")) {
    const panes = await tmux(["list-panes", "-a", "-F", "#{pane_id}"]).catch(() => "");
    return panes.split("\n").includes(target);
  }

  try {
    await tmux(["list-panes", "-t", target, "-F", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

async function getExitStatus(target: string): Promise<string | undefined> {
  const status = await tmux([
    "show-option",
    "-p",
    "-qv",
    "-t",
    target,
    "@pi_tmux_run_status",
  ]).catch(() => "");
  return status.trim() || undefined;
}

async function capturePaneText(target: string): Promise<string> {
  return tmux([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${CAPTURE_LINES}`,
    "-t",
    target,
  ]);
}

async function capturePaneDisplayLines(target: string): Promise<string[]> {
  const output = await tmux([
    "capture-pane",
    "-p",
    "-e",
    "-J",
    "-S",
    `-${CAPTURE_LINES}`,
    "-t",
    target,
  ]);
  const trimmed = output.replace(/\s+$/g, "");
  return (trimmed ? trimmed.split("\n") : [""]).map(sanitizePaneLine);
}

function skipEscapeSequence(value: string, position: number): number {
  const next = value[position + 1];
  if (!next) return 1;

  if (next === "[") {
    for (let i = position + 2; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1 - position;
    }
    return value.length - position;
  }

  if (next === "]" || next === "P" || next === "_" || next === "^") {
    for (let i = position + 2; i < value.length; i++) {
      if (value[i] === "\x07") return i + 1 - position;
      if (value[i] === "\x1b" && value[i + 1] === "\\") return i + 2 - position;
    }
    return value.length - position;
  }

  return 2;
}

function sanitizePaneLine(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const sgr = line.slice(i).match(/^\x1b\[[0-9;:]*m/);
      if (sgr) {
        result += sgr[0];
        i += sgr[0].length;
      } else {
        i += skipEscapeSequence(line, i);
      }
      continue;
    }

    const code = line.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(code);
    if (char === "\t") {
      result += "   ";
    } else if ((code >= 0x20 && code < 0x7f) || code > 0x9f) {
      result += char;
    }
    i += char.length;
  }
  return result;
}

async function waitForTerminal(target: string, waitFor: WaitForOptions, signal?: AbortSignal): Promise<WaitResult> {
  const { condition, timeoutMs, pollMs } = parseWaitFor(waitFor);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const description = waitDescription(condition);

  while (true) {
    if (condition.kind === "event" && condition.event === "target_closed") {
      if (!(await tmuxTargetExists(target))) {
        return { matched: true, condition: description, elapsedMs: Date.now() - startedAt };
      }
    } else if (condition.kind === "event" && condition.event === "exit") {
      const status = await getExitStatus(target);
      if (status !== undefined) {
        return { matched: true, condition: description, status, elapsedMs: Date.now() - startedAt };
      }
    } else if (condition.kind === "regex") {
      const match = (await capturePaneText(target)).match(condition.regex);
      if (match) {
        return { matched: true, condition: description, match: match[0], elapsedMs: Date.now() - startedAt };
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { matched: false, timedOut: true, condition: description, elapsedMs: Date.now() - startedAt };
    }
    await sleep(Math.min(pollMs, remainingMs), signal);
  }
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
  private pendingLine = "";
  private error: string | undefined;
  private state: "running" | "completed" | "unknown" = "unknown";
  private exitStatus: string | undefined;
  private timer: NodeJS.Timeout;
  private scrollOffset = 0;
  private lastResize = "";
  private unsubscribeStream?: () => Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private target: string,
    private title: string = DEFAULT_TITLE,
    private onExit?: (status: string) => void,
  ) {
    this.timer = setInterval(() => void this.refreshStatus(), POLL_MS);
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      this.unsubscribeStream = await subscribePaneOutput(this.target, (chunk) => this.appendChunk(chunk));
      if (this.disposed) {
        await this.unsubscribeStream().catch(() => {});
        this.unsubscribeStream = undefined;
        return;
      }

      await this.refreshOutput();
      if (this.disposed) return;

      await this.refreshStatus();
      if (this.disposed) return;
      this.scrollOffset = maxScrollOffset(this.lineCount(), VISIBLE_LINES);
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
      return;
    }
    if (!this.disposed) this.tui.requestRender();
  }

  private lineCount(): number {
    return this.lines.length + (this.pendingLine ? 1 : 0);
  }

  private appendChunk(_chunk: string): void {
    this.scheduleOutputRefresh();
  }

  private scheduleOutputRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshOutput();
    }, 16);
  }

  private async refreshOutput(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }

    this.refreshRunning = true;
    const wasAtBottom = this.scrollOffset >= maxScrollOffset(this.lineCount(), VISIBLE_LINES);
    try {
      const lines = await capturePaneDisplayLines(this.target);
      if (this.disposed) return;
      this.lines = lines;
      this.pendingLine = "";
      this.scrollOffset = wasAtBottom
        ? maxScrollOffset(this.lineCount(), VISIBLE_LINES)
        : clampScrollOffset(this.scrollOffset, this.lineCount(), VISIBLE_LINES);
      this.error = undefined;
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshRunning = false;
      if (!this.disposed) {
        this.tui.requestRender();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleOutputRefresh();
        }
      }
    }
  }

  private async refreshStatus(): Promise<void> {
    if (this.disposed) return;
    try {
      const exitStatus = await getExitStatus(this.target);
      if (this.disposed) return;
      const wasCompleted = this.state === "completed";
      this.exitStatus = exitStatus;
      this.state = exitStatus ? "completed" : "running";
      if (exitStatus && !wasCompleted) this.onExit?.(exitStatus);
      this.scrollOffset = clampScrollOffset(this.scrollOffset, this.lineCount(), VISIBLE_LINES);
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    }
    if (!this.disposed) this.tui.requestRender();
  }

  handleInput(data: string): void {
    const delta = wheelScrollDelta(data);
    if (delta === undefined) return;

    this.scrollOffset = clampScrollOffset(
      this.scrollOffset + delta,
      this.lineCount(),
      VISIBLE_LINES,
    );
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
    const reset = "\x1b[0m";
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
      : this.pendingLine
        ? [...this.lines, this.pendingLine]
        : this.lines;
    const visible = body.slice(
      this.scrollOffset,
      this.scrollOffset + VISIBLE_LINES,
    );
    for (const line of visible)
      result.push(border("│") + pad(`${" ".repeat(CONTENT_PADDING)}${line}`) + reset + border("│"));
    for (let i = visible.length; i < VISIBLE_LINES; i++)
      result.push(border("│") + pad("") + reset + border("│"));

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
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    clearInterval(this.timer);
    if (this.unsubscribeStream) {
      void this.unsubscribeStream().catch(() => {});
      this.unsubscribeStream = undefined;
    }
  }
}

class TmuxFocusModal implements Component {
  private lines: string[] = [];
  private pendingLine = "";
  private error: string | undefined;
  private state: "running" | "completed" | "unknown" = "unknown";
  private exitStatus: string | undefined;
  private timer: NodeJS.Timeout;
  private scrollOffset = 0;
  private lastResize = "";
  private unsubscribeStream?: () => Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private target: string,
    private title: string,
    private done: () => void,
    private onExit?: (status: string) => void,
  ) {
    enableMouseReporting();
    this.timer = setInterval(() => void this.refreshStatus(), POLL_MS);
    void this.initialize();
  }

  private visibleLines(): number {
    return Math.max(1, this.tui.terminal.rows - 2);
  }

  private async initialize(): Promise<void> {
    try {
      this.unsubscribeStream = await subscribePaneOutput(this.target, (chunk) => this.appendChunk(chunk));
      if (this.disposed) {
        await this.unsubscribeStream().catch(() => {});
        this.unsubscribeStream = undefined;
        return;
      }

      await this.refreshOutput();
      if (this.disposed) return;

      await this.refreshStatus();
      if (this.disposed) return;
      this.scrollOffset = maxScrollOffset(this.lineCount(), this.visibleLines());
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
      return;
    }
    if (!this.disposed) this.tui.requestRender();
  }

  private lineCount(): number {
    return this.lines.length + (this.pendingLine ? 1 : 0);
  }

  private appendChunk(_chunk: string): void {
    this.scheduleOutputRefresh();
  }

  private scheduleOutputRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshOutput();
    }, 16);
  }

  private async refreshOutput(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }

    this.refreshRunning = true;
    const visibleLines = this.visibleLines();
    const wasAtBottom = this.scrollOffset >= maxScrollOffset(this.lineCount(), visibleLines);
    try {
      const lines = await capturePaneDisplayLines(this.target);
      if (this.disposed) return;
      this.lines = lines;
      this.pendingLine = "";
      this.scrollOffset = wasAtBottom
        ? maxScrollOffset(this.lineCount(), visibleLines)
        : clampScrollOffset(this.scrollOffset, this.lineCount(), visibleLines);
      this.error = undefined;
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshRunning = false;
      if (!this.disposed) {
        this.tui.requestRender();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleOutputRefresh();
        }
      }
    }
  }

  private async refreshStatus(): Promise<void> {
    if (this.disposed) return;
    try {
      const exitStatus = await getExitStatus(this.target);
      if (this.disposed) return;
      const wasCompleted = this.state === "completed";
      this.exitStatus = exitStatus;
      this.state = exitStatus ? "completed" : "running";
      if (exitStatus && !wasCompleted) this.onExit?.(exitStatus);
      this.scrollOffset = clampScrollOffset(this.scrollOffset, this.lineCount(), this.visibleLines());
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    }
    if (!this.disposed) this.tui.requestRender();
  }

  handleInput(data: string): void {
    const delta = wheelScrollDelta(data);
    if (delta !== undefined) {
      this.scrollOffset = clampScrollOffset(
        this.scrollOffset + delta,
        this.lineCount(),
        this.visibleLines(),
      );
      this.tui.requestRender();
      return;
    }

    if (parseSgrMouse(data)) return;

    if (matchesKey(data, Key.ctrlShift("f"))) {
      this.done();
      return;
    }

    void sendTmuxInput(this.target, data)
      .then(() => this.tui.requestRender())
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
    const reset = "\x1b[0m";
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
      : this.pendingLine
        ? [...this.lines, this.pendingLine]
        : this.lines;
    const visible = body.slice(
      this.scrollOffset,
      this.scrollOffset + visibleLines,
    );
    for (const line of visible)
      result.push(border("│") + pad(`${" ".repeat(CONTENT_PADDING)}${line}`) + reset + border("│"));
    for (let i = visible.length; i < visibleLines; i++)
      result.push(border("│") + pad("") + reset + border("│"));

    const hints = [
      shortcut(" ctrl+shift+f ") + dim("close focus"),
      dim("scroll wheel scrolls output"),
      dim("input is sent to tmux"),
    ].join(border(" · "));
    const hintsWidth = visibleWidth(hints);
    const leftRuleWidth = Math.max(1, innerW - hintsWidth - 1);
    result.push(border("╰") + border("─".repeat(leftRuleWidth)) + hints + border("─╯"));
    return result;
  }

  invalidate(): void {}

  dispose(): void {
    disableMouseReporting();
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    clearInterval(this.timer);
    if (this.unsubscribeStream) {
      void this.unsubscribeStream().catch(() => {});
      this.unsubscribeStream = undefined;
    }
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
    const shellCommand = `bash -lc ${shellQuote(`${command}
status=$?
printf '\n[Session exited with status %s]\n' "$status"
tmux set-option -p -t "$TMUX_PANE" @pi_tmux_run_status "$status" 2>/dev/null || true`)}`;

    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", cwd],
      {
        encoding: "utf8",
      },
    );

    const paneId = await tmux(["display-message", "-p", "-t", sessionName, "#{pane_id}"]);
    const target = paneId.trim() || sessionName;
    await tmux(["send-keys", "-t", target, "-l", shellCommand]);
    await tmux(["send-keys", "-t", target, "Enter"]);

    if (ctx.hasUI) {
      showWidget(ctx, { target, sessionName, title, command, cwd, state: "running" });
    }

    pi.appendEntry(ENTRY_TYPE, { action: "open", target, sessionName, title, command, cwd, state: "running", at: Date.now() });

    return { sessionName, target, title, command, cwd };
  }

  async function attachLiveTerminal(
    ctx: { hasUI?: boolean },
    target: string,
    options: { title?: string } = {},
  ) {
    const info = await getTmuxTargetInfo(target);
    const title = options.title || info.sessionName || target;
    const attachment = { target: info.target, sessionName: info.sessionName, title, state: "running" as const };
    showWidget(ctx, attachment);
    pi.appendEntry(ENTRY_TYPE, { action: "open", target: info.target, sessionName: info.sessionName, title, attachedExisting: true, at: Date.now() });
    return { sessionName: info.sessionName, target: info.target, title };
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
      disableMouseReporting();
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
        const title = titleParts.join(" ") || target;
        const result = await attachLiveTerminal(ctx, target, { title });
        ctx.ui.notify(attachedMessage(result.sessionName, result.target), "info");
      } catch (error) {
        ctx.ui.notify(`Could not attach to tmux session ${target}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "live_terminal_run",
    label: "Run Live Terminal",
    description:
      "Start a command in a detached tmux session, or attach to an existing tmux target when no command is provided. Can optionally wait for regex output or lifecycle events.",
    promptSnippet:
      "live_terminal_run: run a command in a detached tmux session or attach to an existing session, with a live Tmux widget visible to the user.",
    promptGuidelines: [
      "For interactive, TTY, full-screen, watch-mode, development-server, or long-running flows, use live_terminal_run instead of bash so the user can see and interact with the running process.",
      "Omit command and pass session_name or target to attach to an existing tmux session instead of starting a new command.",
      "Pass wait_for.regex to wait until captured terminal output matches a JavaScript regular expression, or wait_for.event='exit'/'target_closed' to wait for an event. Defaults: timeout_ms=30000, poll_ms=500.",
      "For long-running workflows, prefer starting the live terminal first, doing other useful work, then calling live_terminal_run again without command and with session_name/target plus wait_for when you need to wait for the next terminal state.",
      "When the session is no longer needed, use live_terminal_close to close the widget and kill the tmux session.",
    ],
    parameters: Type.Object({
      command: Type.Optional(
        Type.String({
          description: "Shell command to run in a new tmux session. If omitted, live_terminal_run attaches to session_name or target instead.",
        }),
      ),
      session_name: Type.Optional(
        Type.String({
          description:
            "Optional tmux session name. With command, names the new session and defaults to pi-live-<random>. Without command, names the existing session to attach to.",
        }),
      ),
      target: Type.Optional(
        Type.String({
          description: "Existing tmux target to attach to when command is omitted, e.g. my-session or my-session:0.0.",
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
      wait_for: Type.Optional(
        Type.Object({
          regex: Type.Optional(
            Type.String({
              description: "JavaScript regular expression source to match against captured tmux pane output.",
            }),
          ),
          event: Type.Optional(
            Type.Union([
              Type.Literal("exit"),
              Type.Literal("target_closed"),
            ], {
              description: "Event to wait for. 'exit' waits for commands started by live_terminal_run to record an exit status; 'target_closed' waits until the tmux target disappears.",
            }),
          ),
          ignore_case: Type.Optional(
            Type.Boolean({
              description: "Compile wait_for.regex case-insensitively.",
            }),
          ),
          timeout_ms: Type.Optional(
            Type.Number({
              description: "Maximum time to wait in milliseconds. Defaults to 30000.",
            }),
          ),
          poll_ms: Type.Optional(
            Type.Number({
              description: "Polling period in milliseconds. Defaults to 500.",
            }),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = typeof params.command === "string" ? params.command.trim() : "";
      let result: { sessionName?: string; target: string; title: string; command?: string; cwd?: string };
      let visibleMessage: string;

      if (command) {
        if (params.target) throw new Error("target can only be used when command is omitted.");
        result = await startLiveTerminal(
          { ...ctx, cwd: params.cwd || ctx.cwd },
          command,
          { sessionName: params.session_name, title: params.title || params.session_name || DEFAULT_TITLE },
        );
        visibleMessage = startedVisibleMessage(result.sessionName!);
      } else {
        const attachTarget = params.target || params.session_name;
        if (!attachTarget) throw new Error("live_terminal_run requires command, or session_name/target to attach to an existing tmux session.");
        result = await attachLiveTerminal(ctx, attachTarget, { title: params.title || params.session_name || params.target });
        visibleMessage = attachedMessage(result.sessionName, result.target);
      }

      let waitResult: WaitResult | undefined;
      if (params.wait_for) {
        waitResult = await waitForTerminal(result.target, params.wait_for, signal);
        visibleMessage = `${visibleMessage} ${waitResultMessage(waitResult)}`;
      }

      return {
        content: [
          {
            type: "text",
            text: visibleMessage,
          },
        ],
        details: { sessionName: result.sessionName, target: result.target, command: result.command, cwd: result.cwd, waitResult, visibleMessage },
      };
    },
    renderCall(args, theme) {
      const toolArgs = args as { command?: unknown; session_name?: unknown; target?: unknown; wait_for?: unknown };
      const command = typeof toolArgs.command === "string" ? toolArgs.command : "";
      const attachTarget = typeof toolArgs.target === "string"
        ? toolArgs.target
        : typeof toolArgs.session_name === "string"
          ? toolArgs.session_name
          : "";
      const summary = command ? command : `attach ${attachTarget}`;
      const waitSummary = waitForRenderSummary(toolArgs.wait_for);
      const waitText = waitSummary ? ` wait=${JSON.stringify(compactText(waitSummary, 80))}` : "";
      const content = theme.fg("toolTitle", "live_terminal_run ") + theme.fg("dim", `${compactText(summary, 120)}${waitText}`);
      return new Text(content, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { visibleMessage?: unknown; sessionName?: unknown; waitResult?: { timedOut?: unknown } } | undefined;
      const message = typeof details?.visibleMessage === "string"
        ? details.visibleMessage
        : typeof details?.sessionName === "string"
          ? startedVisibleMessage(details.sessionName)
          : "Opened live terminal.";
      const color = details?.waitResult?.timedOut ? "warning" : "success";
      return new Text(theme.fg(color, message), 0, 0);
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
