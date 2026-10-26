# Install the hooks

These steps are for a coding agent or a person working from a copy of this repository. Install only for the requested runtimes. The default is log-only: the hooks record what they would deliver without adding instructions or blocking writes. Enabling live delivery is a separate step.

## 1. Keep the files at a stable path

Use an existing permanent checkout, or clone the repository you were given into a directory under home such as `$HOME/src/agents-chain`. An extracted package archive also works. Hook commands point to these files, so do not register a temporary checkout, disposable worktree or Downloads directory.

Check Node.js is version 22 or newer, npm and Git are available, and each requested coding agent is installed. Record the runtime versions and resolve an absolute path to Node that will also work when the agent launches hooks.

From a source checkout, run:

```bash
npm ci
npm run check
node agents-chain-report --help
```

There are no runtime package dependencies and no npm registry publication to install from. No global npm install is needed.

Package archives omit the tests and development scripts. For an extracted archive, run `node agents-chain-report --help` and use the command and log checks below instead of `npm run check`.

## 2. Find the settings to edit

| Runtime | User settings | Example to merge |
| --- | --- | --- |
| Codex | `${CODEX_HOME:-$HOME/.codex}/config.toml`, or an existing `hooks.json` beside it | [examples/codex.toml](examples/codex.toml) |
| Claude Code | `~/.claude/settings.json` | [examples/claude.json](examples/claude.json) |

Inspect the relevant hook registrations before adding any. Include active project, plugin and session sources when checking for another copy of these hooks. If they are already installed, reuse or update that registration rather than adding a second one. Preserve an existing live/log-only choice unless the installation request changes it.

Preserve unrelated settings and hooks. Back up any settings file being changed with private permissions, and record its path for rollback. If dotfile tooling, symlinks or a configuration manager owns the file, edit its authoritative source and verify the resulting runtime settings. Do not replace an entire settings file with an example.

Leave existing `AGENTS.md`, `CLAUDE.md`, imports and symlinks in place. Native global instructions remain part of the setup. Read the [supported native-loading assumptions](docs/handling.md#supported-native-loading-setup); custom configuration directories or discovery settings outside that contract need verification before claiming the setup works. Report managed restrictions that prevent registration rather than working around them.

## 3. Merge the hook entries

Use the matching example's `SessionStart` and `PreToolUse` groups. Replace the example command's Node and script paths with the absolute paths from step 1. Quote each shell path separately and encode the resulting command correctly in JSON or TOML, including paths containing spaces. Keep `--log-only` on both commands, the matchers and timeouts from the examples, and synchronous execution. No service or daemon needs to be started.

For Codex, keep the existing hook representation when possible. If using `hooks.json`, translate the example groups into the same `hooks` event object in JSON. Merge with existing event arrays; do not create a duplicate TOML table or a second registration in another file. Codex combines matching sources and requires review of new or changed definitions through `/hooks`. [Codex hook configuration and review](https://learn.chatgpt.com/docs/hooks).

For Claude Code, merge the example's `pluginConfigs` entry as well as its hooks. It selects `claude-md-and-agents-md`, which the hooks' native-loading model expects. Preserve other plugin settings. If the built-in AGENTS plugin is disabled, it must be enabled through Claude's `/plugin` interface before that assumption holds. This setting belongs in user settings or an explicit `--settings` file, not project/local settings. [Claude instruction settings](https://code.claude.com/docs/en/memory#choose-which-instruction-files-load).

## 4. Check the commands and registration

Validate the edited JSON/TOML and inspect the diff. Confirm that only the requested hook groups and Claude instruction setting changed, the paths exist, and each event has one registration of these hooks for the intended mode.

Run each configured hook command with `--help` added. Then smoke-test the actual configured command with synthetic `SessionStart` and `PreToolUse` payloads using a unique session ID and a disposable file under home. A start payload needs `session_id`, `hook_event_name`, `source: "startup"` and `cwd`; a pre-tool payload needs the same session and working directory plus `tool_name: "Bash"` and `tool_input: {"command": "cat /absolute/path/to/the/disposable-file"}`. Omit `source` from the pre-tool payload. Send each JSON object on stdin. In log-only mode both commands should exit 0 with no context or block output.

Summarize the logs from the checkout:

```bash
node agents-chain-report --json
```

Use the same `XDG_STATE_HOME` as the configured command if one is set. Check for fresh records for the tested runtime with `mode: "log"`, both events, and no internal errors. A logged `bounce` is only a projected block in this mode.

Command smoke tests prove the scripts run. To verify runtime registration, start a fresh ordinary agent session, complete Codex's `/hooks` review if applicable, and use a supported file tool or shell read. Confirm that this new session produces its own log records. Do not bypass hook trust or describe the runtime registration as verified solely because a synthetic invocation worked. If an interactive step remains, report it explicitly.

## 5. Hand back a concise result

Report the stable checkout path, settings sources and backup paths, requested runtimes and versions, installed mode, checks performed, and any remaining interactive review. Installation can be complete in log-only mode; that does not establish model-visible delivery. Leave existing global instruction files untouched.

To enable delivery, run the [isolated before/after probes](docs/probes.md), compare the canaries and retries, then remove `--log-only` from both event commands when the user requests live mode. Re-review changed Codex hooks and start fresh sessions. Keep the [handling and limits](docs/handling.md) available for monitoring and rollback.

## Update or remove

To update, keep the installation path stable and obtain the intended revision. For a source checkout, rerun `npm ci` and `npm run check`; for an archive, repeat the command checks. Verify the registrations and logs, and re-review hooks if Codex marks a definition as changed.

To return to observation, add `--log-only` to both event commands and start fresh sessions. To remove the hooks, remove only their event groups from the authoritative settings, verify the resulting files, then start fresh sessions. Leave unrelated hooks, native instruction files and shared imports/symlinks intact. The private state under `${XDG_STATE_HOME:-$HOME/.local/state}/agents-chain/` can be removed separately after it is no longer needed.
