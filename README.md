# Decision Center

A feed of the Claude Code and Codex sessions on this machine that finished a turn, need permission, or asked a question. Pick an item to read the session's last message and reply to it from the browser. The reply is typed into the session's tmux pane.

Agent hooks report what each session is doing. tmux is how replies reach a session.

## Requirements

- macOS or Linux.
- Node 22 or later.
- tmux 3.2 or later. Run your agents inside tmux to reply from the feed.
- Claude Code and/or Codex.
- For **Suggest replies** only: Claude Code installed and logged in (see below).

## Install

1. Clone this repo. `dist/` is committed, so there is nothing to build.
2. Add the hooks:

   ```sh
   node dist/decision-center.mjs install --dry-run   # shows what would change
   node dist/decision-center.mjs install
   ```

   This adds one entry per hook event to `~/.claude/settings.json` and `~/.codex/hooks.json`. Every other entry stays where it is. Each file is backed up beside itself before it changes, as `<file>.decision-center-backup-<time>`. Running `install` again changes nothing. Pass `--claude-settings <path>` or `--codex-hooks <path>` to touch only the file you name.
3. Codex asks you to trust new or changed hooks the next time it starts. Accept the prompt. Untrusted hooks don't run, and the feed then sees no Codex sessions.

The hook command is the absolute path of your `node` plus the absolute path of `dist/hook.mjs`. If you move the folder or change Node versions, run `install` again. `node dist/decision-center.mjs uninstall` removes the entries and leaves the rest of each file alone.

To type `decision-center` instead, add an alias such as `alias decision-center='node ~/src/decision-center/dist/decision-center.mjs'`.

## Use

1. Run `decision-center serve` in a terminal. It serves the feed on `http://127.0.0.1:47823` and runs until you stop it with `Ctrl-C`. Nothing starts it for you.
2. Run `decision-center open`, or open that address yourself.
3. Pick an item. Questions and permission asks come first under **Waiting on you**, then **Finished**, then **Session closed**.
4. Reply with a quick reply, an option number, or free text. Each reply waits 3 s so you can undo it with `Esc`, then it's typed into the pane and the view moves to the next item.

Press `?` for every shortcut. `⌘K` jumps to any item. **Open pane** (`o`) selects the session's tmux window and pane, and switches your tmux client to it.

Permission asks get **Allow** (`1`) and **Deny** (`2`), with an optional note that goes to the agent with your answer. "Always allow" rules are set in the pane. A question with several parts shows one row of options per part: pick in each, then send them together.

Some things are left to the pane itself, behind an **Open pane** button: Codex questions with several parts, parts with no options to pick, and typed answers to those questions.

Before it types anything, Decision Center reads the pane's screen. It refuses to reply when the prompt it expects isn't there, when you have unsent text in the composer, or when the pane is in tmux copy mode.

`decision-center status` shows the home folder, whether the hooks are installed, how many sessions it has seen, the tmux version and whether the server runs.

### Sessions outside tmux

Hooks fire in every terminal, so these sessions still show up in the feed. Replies and **Open pane** are refused with "this session is not running in tmux; reply in its terminal".

### Failed replies

When a reply doesn't go through, the item shows **Not sent** with the reason. **Details** (or `!`) opens the failed-replies list, and a **Failed N** button in the header opens it too. Each entry shows what you sent, the error, the keys already typed into the pane, any unsent text in the pane's composer, and the bottom of the pane's screen at that moment. **Copy report** puts them all on the clipboard as JSON. The last 50 are kept in `failures.json` in the home folder and are never sent anywhere.

### Quick replies

If the last message ends with a `Next:` line or a numbered list, its first 3 items become reply chips. Clicking a chip fills the text box. It doesn't send.

**Suggest replies** asks Claude Haiku for chips when the message has none. It runs your own `claude` CLI (`claude -p --model haiku`, with no settings, hooks, MCP servers, tools or saved session). It needs Claude Code installed and logged in, and each press costs about $0.005 on your Claude account. Without Claude Code, the button shows an error and everything else still works.

### Alerts

Decision Center raises no banners or sounds of its own. The unread count shows in the feed and in the tab title, for example `(3) Decision Center`.

## What it stores and runs

The home folder is `~/.decision-center`, or `$DECISION_CENTER_HOME`. The folder is mode 700 and its files are mode 600.

- `sessions/<agent>-<session id>.jsonl`: one line per hook call. Each line holds the hook event, the time, the session id, the working folder, the transcript path, the subagent id, and for Claude the tmux pane and the agent's process id. It also holds the prompt (first 8 KB), the agent's last message (first 64 KB), the tool name, a short hash that names the tool call, and a summary of up to 200 characters (the command or the file path). Question tools also keep their questions and options. Tool output is never written. Files with no event for 7 days are deleted when the server starts.
- `flags.json`: which items you read or dismissed.
- `failures.json`: the last 50 failed replies.

The hook runs on every hook call of every session. It reads the payload, appends one line, and exits 0 with nothing on stdout, whatever happens. It makes no network calls and starts no processes. It takes about 25 ms per call, measured as the median of 35 runs on an Apple Silicon Mac. About 20 ms of that is Node starting up.

The server runs these programs:

- `tmux` to list panes, read a pane's screen, type replies and select a pane.
- `ps`, to see whether a session's process still runs, and `lsof`, to find the folder a Codex process runs in.
- `claude`, when you press **Suggest replies**.

The server listens on `127.0.0.1` only. Set `DECISION_CENTER_PORT` to use another port. Nothing leaves your machine except the Suggest replies call, which goes to Anthropic through your own Claude Code login.

## Limits

- Denying or cancelling an ask in the pane, or pressing `Esc` on a question, fires no hook. In tmux, the feed reads the pane's screen and drops the ask once the prompt is gone, within 30 s. The session then shows nothing until its next turn ends. Outside tmux, the ask stays in the feed until the session's next hook.
- A Codex hook runs in a shared background process, so it can't say which pane its session is in. Decision Center finds the pane from the `codex` process on the pane's terminal that runs in the session's folder. With two Codex sessions in one folder it can't always tell them apart, and then the session shows as if it ran outside tmux.
- A Codex session counts as closed once no `codex` process with a terminal runs in its folder. Codex ends sessions without a hook, so a closed Codex session leaves the feed only on the next refresh, within 30 s.
- With Claude Code's `auto` permission mode, permission asks never appear, so the feed shows none.

## Develop

```sh
npm install
npm test          # typecheck, unit tests, bundle freshness
npm run build     # rebuild dist/decision-center.mjs and dist/hook.mjs; commit them
npm run preview   # serve the page against fixtures
```

## License

MIT
