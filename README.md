<img width="1680" height="720" alt="tanishqk_Overhead_aerial_view_of_New_York_City_at_golden_hour_650bc1e7-22f5-4e28-9576-ceaa73ed132c_0" src="https://github.com/user-attachments/assets/219e4167-d04f-4c8a-9373-bdf3a6e96856" />

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
