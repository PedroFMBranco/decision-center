# Decision Center

An [Orca](https://github.com/stablyai/orca) plugin. It shows a feed of the Claude Code and Codex sessions on this Mac that finished a turn, need permission, or asked a question. Pick an item to read the session's last message and reply to it without switching panes.

## Requirements

- Orca 1.4.206 or later, on macOS.
- Claude Code and/or Codex sessions running in Orca terminals.
- For **Suggest replies** only: Claude Code installed and logged in (see below).

## Install

Settings → Plugins → Install, then either:

- **Git**: `https://github.com/PedroFMBranco/orca-decision-center.git`, ref `v0.2.0`.
- **Local folder**: a clean checkout of this repo. Install copies the whole folder except `.git`, so don't point it at a working copy that has `node_modules/`.

Installs never run a build. The committed `dist/main.mjs` is what runs.

## Use

1. Press ⌘J and run **Decision Center: Open**. The feed opens in an Orca browser tab.
2. Pick an item. Questions and permission asks come first under **Waiting on you**, then **Finished**, then **Session closed**.
3. Reply with a quick reply, an option number, or free text. Each reply waits 3 s so you can undo it with `Esc`, then it's typed into the pane and the view moves to the next item.

Press `?` for every shortcut. `⌘K` jumps to any item.

Permission asks get **Allow** (`1`) and **Deny** (`2`), with an optional note that goes to the agent with your answer. "Always allow" rules are set in the pane. A question with several parts shows one row of options per part: pick in each, then send them together.

Some things are left to the pane itself, behind an **Open pane** button: Codex questions with several parts, parts with no options to pick, and typed answers to those questions.

### Quick replies

If the last message ends with a `Next:` line or a numbered list, its first 3 items become reply chips. Clicking a chip fills the text box. It doesn't send.

**Suggest replies** asks Claude Haiku for chips when the message has none. It runs your own `claude` CLI (`claude -p --model haiku`, with no hooks, MCP servers, tools or saved session). It needs Claude Code installed and logged in, and each press costs about $0.005 on your Claude account. Without Claude Code, the button shows an error and everything else still works.

### Alerts

Decision Center raises no banners or sounds of its own. Orca already alerts you: turn on **Agent Task Complete** in Orca's notification settings. The unread count shows in the feed and in the tab title, for example `(3) Decision Center`.

## What it can do

The manifest asks for two capabilities:

- `events:subscribe`: wakes the feed when an agent's status changes.
- `storage`: keeps read and dismissed flags across restarts.

The plugin worker also does these things outside the capability model (Orca doesn't sandbox workers today):

- Runs the `orca` CLI to list worktrees and terminals, read a pane's screen, type replies and switch panes.
- Reads `~/Library/Application Support/orca/agent-hooks/last-status.json` and Codex transcripts under `~/.codex/sessions/` to find questions and their options.
- Serves the feed on `http://127.0.0.1:47823`, reachable from this Mac only.
- Runs `claude` when you press **Suggest replies**.

Nothing leaves your Mac except the Suggest replies call, which goes to Anthropic through your own Claude Code login.

## Develop

```sh
npm install
npm test          # typecheck, unit tests, bundle freshness, package limits
npm run build     # rebuild dist/main.mjs; commit it
npm run preview   # serve the page against fixtures
```

To load it while developing, add this folder's absolute path under Settings → Plugins → Development. Orca doesn't expand `~`, so `~/…` shows up as an invalid plugin. The worker doesn't reload on edit: bump `version` in `orca-plugin.json` after a rebuild.

## License

MIT
