import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRunWrapperScript,
  lineForMatch,
  waitResultMessage,
  type WaitResult,
} from "../pi-live-terminal.ts";

test("wrapper puts user command in a subshell so exit N cannot skip status recording", () => {
  const script = buildRunWrapperScript("exit 1");

  assert.match(script, /^\(exit 1\)/m);
  assert.ok(script.indexOf("status=$?") > script.indexOf("(exit 1)"));
  assert.match(script, /tmux set-option -p -t "\$TMUX_PANE" @pi_tmux_run_status "\$status"/);
  assert.match(script, /rm -f -- "\$0"/);
});

test("wrapper keeps a multiline command inside one subshell", () => {
  const script = buildRunWrapperScript("echo start\nexit 0\necho unreachable");
  const subshell = script.slice(script.indexOf("("), script.indexOf("status=$?"));

  assert.equal(subshell, "(echo start\nexit 0\necho unreachable)\n");
});

test("waitResultMessage prefers exitedEarly over a raw status (same result has both)", () => {
  const result: WaitResult = {
    matched: false,
    exitedEarly: true,
    condition: 'regex "tests passed"',
    elapsedMs: 3655,
    status: "1",
  };

  assert.equal(
    waitResultMessage(result),
    'Process exited with status 1 before regex "tests passed" matched (after 3655ms).',
  );
});

test("waitResultMessage keeps timeout, exit-match, and full-line regex copy", () => {
  assert.equal(
    waitResultMessage({
      matched: false,
      timedOut: true,
      condition: 'regex "ready"',
      elapsedMs: 30000,
    }),
    'Timed out after 30000ms waiting for regex "ready".',
  );

  assert.equal(
    waitResultMessage({
      matched: true,
      condition: "event exit",
      elapsedMs: 1200,
      status: "0",
    }),
    "Matched event exit with status 0 after 1200ms.",
  );

  assert.equal(
    waitResultMessage({
      matched: true,
      condition: 'regex "passed"',
      elapsedMs: 800,
      match: "12 passing (32ms)",
    }),
    "Matched wait regex:\n\n12 passing (32ms)",
  );
});

test("lineForMatch returns the full pane line around a regex hit", () => {
  const output = "compiling...\n  ✓ tests passed (12ms)\ndone";
  const match = output.match(/tests passed/);
  assert.ok(match);
  assert.equal(lineForMatch(output, match), "  ✓ tests passed (12ms)");
});
