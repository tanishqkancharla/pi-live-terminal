import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRunWrapperScript } from "../pi-live-terminal.ts";

function tmuxSocket(): { socket: string; args: (extra: string[]) => string[] } {
  const socket = `pi-live-test-${randomBytes(4).toString("hex")}`;
  return {
    socket,
    args: (extra) => ["-L", socket, ...extra],
  };
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

async function pollExitStatus(tmuxArgs: (extra: string[]) => string[], target: string, timeoutMs = 4000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = tmux(tmuxArgs(["show-option", "-p", "-qv", "-t", target, "@pi_tmux_run_status"])).trim();
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for @pi_tmux_run_status on ${target}`);
}

test("subshell wrapper records status when the command is exit 1", async () => {
  const { socket, args } = tmuxSocket();
  const session = "wrap";
  const scriptPath = join(tmpdir(), `${socket}.sh`);
  writeFileSync(scriptPath, buildRunWrapperScript("exit 1"));

  tmux(args(["new-session", "-d", "-s", session]));
  try {
    const target = tmux(args(["display-message", "-p", "-t", session, "#{pane_id}"])).trim();
    tmux(args(["send-keys", "-t", target, "-l", `bash ${JSON.stringify(scriptPath)}`]));
    tmux(args(["send-keys", "-t", target, "Enter"]));
    assert.equal(await pollExitStatus(args, target), "1");
  } finally {
    tmux(args(["kill-server"]));
  }
});

test("without a subshell, exit 1 skips the status wrapper", async () => {
  const { socket, args } = tmuxSocket();
  const session = "bare";
  const scriptPath = join(tmpdir(), `${socket}.sh`);
  writeFileSync(
    scriptPath,
    "exit 1\nstatus=$?\ntmux set-option -p -t \"$TMUX_PANE\" @pi_tmux_run_status \"$status\" 2>/dev/null || true\n",
  );

  tmux(args(["new-session", "-d", "-s", session]));
  try {
    const target = tmux(args(["display-message", "-p", "-t", session, "#{pane_id}"])).trim();
    tmux(args(["send-keys", "-t", target, "-l", `bash ${JSON.stringify(scriptPath)}`]));
    tmux(args(["send-keys", "-t", target, "Enter"]));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = tmux(args(["show-option", "-p", "-qv", "-t", target, "@pi_tmux_run_status"])).trim();
    assert.equal(status, "", "status must stay unset when exit skips the wrapper");
  } finally {
    tmux(args(["kill-server"]));
  }
});
