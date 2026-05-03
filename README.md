# pi-plan-mode

Plan mode extension for [pi](https://github.com/badlogic/pi): a toggleable read-only mode that blocks write/edit tools.

## Features

- **Simple toggle**: `/plan` enables/disables plan mode
- **Prompted planning**: `/plan <request>` enters plan mode and starts a planning turn immediately
- **Blocks write/edit tools**: When active, `write` and `edit` tools are completely blocked
- **Controlled plan saving**: `save_plan` is the only write-capable tool in plan mode and only stores Markdown under the plan storage directory
- **Post-plan action menu**: When a plan finishes, choose whether to implement here, implement in a new conversation, store the plan, or keep planning
- **Smart bash filtering**: Safe commands allowed, mutating commands reviewed by AI
- **Git command protection**: Mutating git commands (`commit`, `push`, `pull`, `merge`, etc.) are blocked
- **Status indicator**: Shows "⚠️ planning" in the UI when active
- **Session persistence**: Plan mode state survives session resume
- **Bash override memory**: Approved commands are remembered within a session

## Quick Start

1. Enable plan mode: `/plan`
2. Or enter plan mode and start planning immediately: `/plan how to update this extension`
3. Explore the codebase with read-only tools
4. When the plan completes, choose an action from the post-plan menu, or disable plan mode manually with `/plan`

## Command Reference

| Command | What it does |
|---|---|
| `/plan` | Toggle plan mode on/off |
| `/plan <request>` | Enable/keep plan mode active and send `<request>` to the agent as a planning-only task |
| `/plan-implement-new` | Retry/fallback command to start a new conversation seeded with the most recently captured plan |

## Post-Plan Actions

When an assistant turn ends in plan mode and UI is available, pi-plan-mode captures the latest assistant plan and prompts for the next action:

- **Exit plan mode and implement here**: disables plan mode, restores normal tools, and sends the captured plan back as an implementation request in the current conversation.
- **Implement in a new conversation**: starts a new session automatically when a command context is available and seeds it with the implementation prompt. If automatic startup is unavailable, run `/plan-implement-new` to retry with the captured plan.
- **Store plan**: writes the captured plan to a timestamped Markdown file under the configured plan storage directory.
- **Stay in plan mode**: leaves plan mode active.

## Configuration

Configuration is read from, in precedence order from lowest to highest:

1. `~/.pi/agent/settings.json` (`planMode` object)
2. `~/.pi/agent/plan-mode.json` (legacy)
3. `<cwd>/.pi/settings.json` (`planMode` object)
4. `<cwd>/.pi/plan-mode.json` (legacy project values override all others)

Plan storage is resolved in this order:

1. `DEFAULT_PLAN_STORAGE` environment variable
2. `defaultPlanStorage` in config
3. `<cwd>/tmp`

Thinking configuration:

- No configured thinking value means `/plan` preserves the current thinking level.
- `defaultThinkingLevel`: thinking level to apply while plan mode is active (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `defaultThinkingEffort`: alias for `defaultThinkingLevel`
- `restoreThinkingLevel`: restore the previous thinking level on exit; defaults to `true`

Pi settings example (`~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`):

```json
{
  "planMode": {
    "defaultPlanStorage": "tmp",
    "defaultThinkingLevel": "high",
    "restoreThinkingLevel": true
  }
}
```

Alias example:

```json
{
  "planMode": {
    "defaultThinkingEffort": "high"
  }
}
```

Legacy `plan-mode.json` files are still supported:

```json
{
  "defaultPlanStorage": "tmp",
  "defaultThinkingLevel": "high",
  "restoreThinkingLevel": true
}
```

Relative storage paths resolve against the current working directory.

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
