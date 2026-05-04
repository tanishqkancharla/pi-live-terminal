# pi-live-terminal

Pi extension that adds a `tmux_run` tool and a live tmux widget inside Pi.

## What it does

- Starts long-running or interactive commands in detached tmux sessions.
- Shows live terminal output in a Pi widget above the editor.
- Reattaches the widget when a Pi session restarts and the tmux pane still exists.
- Adds `/tmux-attach` and `/live-terminal-close` commands.
- Adds shortcuts:
  - `ctrl+shift+x` — unattach and kill the tmux pane
  - `ctrl+shift+v` — unattach without killing the tmux pane

## Install

```sh
ln -sf "$(pwd)/pi-live-terminal.ts" ~/.pi/agent/extensions/pi-live-terminal.ts
```

Restart Pi after installing or updating the extension.

## Requirements

- [tmux](https://github.com/tmux/tmux)
- Pi coding agent extension runtime
