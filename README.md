# pi-plan-mode

Plan mode extension for [pi](https://github.com/badlogic/pi): a toggleable read-only mode that blocks write/edit tools.

## Features

- **Simple toggle**: `/plan` enables/disables plan mode
- **Prompted planning**: `/plan <request>` enters plan mode and starts a planning turn immediately
- **Blocks write/edit tools**: When active, `write` and `edit` tools are completely blocked
- **Controlled plan saving**: `save_plan` is the only write-capable tool in plan mode and only stores Markdown under the plan storage directory
- **Smart bash filtering**: Safe commands allowed, mutating commands reviewed by AI
- **Git command protection**: Mutating git commands (`commit`, `push`, `pull`, `merge`, etc.) are blocked
- **Status indicator**: Shows "⚠️ planning" in the UI when active
- **Session persistence**: Plan mode state survives session resume
- **Bash override memory**: Approved commands are remembered within a session

## Quick Start

1. Enable plan mode: `/plan`
2. Or enter plan mode and start planning immediately: `/plan how to update this extension`
3. Explore the codebase with read-only tools
4. Disable plan mode: `/plan` again

## Command Reference

| Command | What it does |
|---|---|
| `/plan` | Toggle plan mode on/off |
| `/plan <request>` | Enable/keep plan mode active and send `<request>` to the agent as a planning-only task |

## Safety & Restrictions

In plan mode:
- `write` and `edit` tools are blocked
- `save_plan` is allowed for Markdown plans only (`.md`/`.mdx`)
- Plans are stored under `$DEFAULT_PLAN_STORAGE` when set, otherwise `<cwd>/tmp`
- Plan paths must stay inside the storage root; traversal and symlink escapes are rejected
- Safe bash commands (ls, cat, grep, find, etc.) are allowed
- Shell redirects, `tee`, heredocs, and scripting write patterns are blocked
- Potentially mutating bash commands are reviewed by an AI model
- Mutating git commands are blocked
- Commands can be approved manually and remembered for the session

## Installation

```bash
npm install pi-plan-mode
```

Then enable it in pi via your packages/extensions configuration.

## Development

- Type-check: `npm run typecheck`
- Releases: see `docs/releases.md`

## License

MIT
