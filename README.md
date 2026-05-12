<img width="1680" height="720" alt="tanishqk_Overhead_aerial_view_of_New_York_City_at_golden_hour_650bc1e7-22f5-4e28-9576-ceaa73ed132c_0" src="https://github.com/user-attachments/assets/219e4167-d04f-4c8a-9373-bdf3a6e96856" />

# pi-live-terminal

Pi extension that adds `live_terminal_run` and `live_terminal_close` tools plus a live tmux widget inside Pi.

https://github.com/user-attachments/assets/b4ec6d34-fd8a-4254-bf74-e216779649f6

## What it does

- Starts long-running or interactive commands in detached tmux sessions.
- Can attach to an existing tmux session by calling `live_terminal_run` without a command and passing `session_name` or `target`.
- Can wait for terminal output or lifecycle events with `live_terminal_run({ wait_for: ... })`.
- Closes the live pane and kills the attached tmux session with `live_terminal_close`.
- Shows live terminal output in a Pi widget above the editor.
- Streams pane output via `tmux pipe-pane` for event-driven updates (no capture polling loop for output).
- Reports completed processes to the human and agent with the exit status code.
- Reattaches the widget when a Pi session restarts and the tmux session still exists.
- Adds `/live-terminal:run`, `/live-terminal:attach`, `/live-terminal:focus`, and `/live-terminal:close` commands.
- Adds shortcuts:
  - `ctrl+shift+f` — focus the tmux session in a full-screen interactive modal; press it again to close the modal
  - `ctrl+shift+x` — detach and kill the tmux session
  - `ctrl+shift+v` — detach without killing the tmux session; after completion, close the widget

## Waiting from `live_terminal_run`

`live_terminal_run` returns immediately by default. Pass `wait_for` to block the tool call until a condition matches or times out:

```ts
live_terminal_run({
  command: "npm run dev",
  wait_for: { regex: "Local:|ready", timeout_ms: 60000 }
})
```

`wait_for.regex` is a JavaScript regular expression source matched against captured tmux pane output. It uses multiline matching by default, and `ignore_case: true` adds case-insensitive matching.

Supported events:

- `exit` — waits until a command started by `live_terminal_run` records its exit status.
- `target_closed` — waits until the attached tmux pane/session no longer exists.

Defaults: `timeout_ms: 30000`, `poll_ms: 500`.

## Install

```sh
pi install npm:pi-live-terminal
```

Restart Pi after installing or updating the extension.

## Requirements

- [tmux](https://github.com/tmux/tmux)
- Pi coding agent extension runtime
