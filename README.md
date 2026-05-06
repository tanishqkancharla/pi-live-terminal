# pi-live-terminal

Pi extension that adds a `run_live_terminal` tool and a live tmux widget inside Pi.

https://github.com/user-attachments/assets/b4ec6d34-fd8a-4254-bf74-e216779649f6

## What it does

- Starts long-running or interactive commands in detached tmux sessions.
- Shows live terminal output in a Pi widget above the editor.
- Reports completed processes to the human and agent with the exit status code.
- Reattaches the widget when a Pi session restarts and the tmux session still exists.
- Adds `/live-terminal:run`, `/live-terminal:attach`, `/live-terminal:focus`, and `/live-terminal:close` commands.
- Adds shortcuts:
  - `ctrl+shift+f` — focus the tmux session in a full-screen interactive modal; press it again to close the modal
  - `esc` — close the focused modal
  - `ctrl+shift+x` — detach and kill the tmux session
  - `ctrl+shift+v` — detach without killing the tmux session; after completion, close the widget

## Install

```sh
pi install npm:pi-live-terminal
```

Restart Pi after installing or updating the extension.

## Requirements

- [tmux](https://github.com/tmux/tmux)
- Pi coding agent extension runtime
