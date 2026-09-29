# CLI Handoff

A local bridge for continuing the same task between native Codex CLI and Claude Code. Conversation evidence, structured checkpoints, workspace fingerprints, and immutable handoff revisions live outside your project. No API keys or separate model account are needed.

## Use it

Open each CLI in the **same project directory**. After installation, start new sessions so they discover the skills.

In Claude Code:

```text
/export-sync
```

In Codex, invoke the skill through its native picker:

```text
$export-sync
```

Then, in the other CLI:

```text
Continue from the synced conversation.
```

You can explicitly use `/import-sync` in Claude or `$import-sync` in Codex. If multiple tasks are available, provide the handoff ID shown by export. Export is deliberate: ordinary new conversations do not automatically resume unrelated work.

In a new terminal tab, you can also run:

```sh
cd /path/to/project
handoff open claude
# or
handoff open codex
```

This starts the original CLI in that tab with the handoff selected. It does not manipulate your terminal application.

The assistant exporting the task sends a structured checkpoint with your goal, constraints, decisions, current work, next actions, outstanding questions, and test evidence through one local tool call. The receiving assistant reads it, checks live files, and binds its native session to the same task. A later export keeps the lineage and earlier history accessible.

## Install and remove

Requires Node with native TypeScript support (Node 22.18+ or a supported later version), and the native CLIs on PATH. Tested with Codex 0.159.x and Claude Code 2.1.285 on macOS.

```sh
node src/cli.ts install
handoff doctor
```

Installation adds `handoff` under `~/.local/bin`, export/import/status skills to each CLI's user skill directory, a local `cli-handoff` MCP server to both CLIs through their native configuration commands, and small session identity hooks. Existing settings are preserved. Put `~/.local/bin` on PATH if needed; skills also use the absolute executable path. Everything runs locally over stdio; there is no listening network server.

**Optional Codex identity hooks require native trust:** open `/hooks` and trust the two handoff entries. Hook trust is never bypassed. Export/import also work without hooks through `CODEX_THREAD_ID` and Claude's native session placeholder. The connected local tools perform archive operations outside the model's shell sandbox. Normal native tool permission prompts still apply. If connected tools are unavailable, the skills fall back to executable commands; approve narrowly scoped archive writes if your sandbox requires it. `handoff open codex` requests the archive as an additional writable directory, subject to your active permission profile.

```sh
handoff uninstall
```

Uninstall removes owned hooks, unchanged MCP definitions, and unmodified generated files, preserving unrelated configuration and saved archives. If you edit a generated skill yourself, uninstall leaves that file in place. Keep this source directory while installed: the launcher references it.

## Commands

```sh
handoff status
handoff doctor
handoff sessions --provider codex
handoff sessions --provider claude
handoff import HANDOFF_ID --provider claude
handoff history HANDOFF_ID --query "decision" --limit 20
handoff history HANDOFF_ID --offset 20 --limit 20
```

Import reads a packet; the assistant then acknowledges it after loading. Merely opening a CLI does not consume an export. The native skills prefer connected `handoff_export`, `handoff_import`, `handoff_ack`, and `handoff_history` tools. For manual export, `handoff prepare --provider NAME --session ID` creates a checkpoint draft and lists its schema. Fill the draft, then run `handoff export --provider NAME --session ID --checkpoint FILE`. `--checkpoint -` reads JSON from stdin for a single-command export.

Data defaults to `~/.local/share/cli-handoff`. For isolated testing, set `HANDOFF_HOME`, `HANDOFF_DATA_DIR`, and `CODEX_HOME` to temporary directories. A workspace is identified by its real path, so separate Git worktrees are separate workspaces.

## Fidelity and limits

- Captures exact selected sessions, not the most recently modified session on the machine.
- Codex uses read-only app-server APIs, including paginated turns/items. Legacy transcript fallback is allowed only for legacy sessions.
- Claude archives public conversation records and available linked agent transcripts. Private reasoning is excluded. Available attachments are referenced; assets are not copied.
- The starting packet contains the full checkpoint plus bounded recent excerpts. Older evidence is available with `handoff history`, including ancestor handoffs. Saving history does not place it all in the model's context at once.
- Git files and instruction files are fingerprinted. Sensitive file paths are excluded from patches. Untracked file contents are not copied. Conversation archives may contain sensitive information already present in your conversation; storage is local with restrictive permissions.
- In non-Git directories, fingerprints cover instruction files and explicit checkpoint artifact paths, rather than the entire directory.
- Current workspace changes are reported. Exported patches are never applied automatically.
- Model behavior, private reasoning, permissions, and live processes do not transfer identically. Missing history and compaction limits are reported.
- Automatic background capture, cross-machine transfer, and terminal tab creation are not implemented in this version.

## Verify

```sh
npm test
```

Tests cover roundtrip lineage, constraint/history preservation, task ambiguity, workspace drift, archive integrity, incomplete records, credential path exclusions, pagination, locks, and reversible installation.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.
