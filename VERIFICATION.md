# Verification

Verified locally on macOS on 2026-09-29 with Codex CLI 0.159.1 and Claude Code 2.1.285. Native TypeScript execution was exercised with Node 23.10.0 and 26.9.0.

## Automated checks

`npm test` runs isolated filesystem and Git fixtures without model accounts. Checks cover roundtrip task lineage and constraints, concurrent task selection, divergent sessions, stale workspace detection, checksums, partial transcript writes, session mismatch rejection, paginated native history, checkpoint validation, credential file exclusions, locks, history search, reversible installation, connected tool argument validation, stdio MCP protocol responses, and stdin export.

The GitHub workflow runs the same suite on Linux and macOS using Node 22 and 24. See Actions for the actual remote results.

## Native CLI verification

An isolated scratch Git project was used for this sequence:

1. Codex discovered the installed export skill and exported its exact paginated conversation.
2. Claude invoked its native import skill, loaded the packet, and acknowledged the task with its native session ID.
3. Claude invoked its export skill and created a return revision with the same task ID and correct parent revision.
4. A new Codex session imported that return revision, acknowledged it, and reported three distinctive user constraints verbatim.
5. The scratch workspace stayed unchanged throughout the roundtrip.

One headless Claude process timed out while awaiting its final stdout response. Its persisted native session subsequently completed the return export. The resulting archive, task lineage, constraints, and successful Codex return import were verified directly. Headless process completion timing is therefore not a guarantee of this test.

Shell archive writes in Codex encountered a sandbox permission error and succeeded after a scoped retry. A local MCP interface was added to avoid requiring shell write access for normal transfers. Claude's native MCP diagnostics reported the installed server connected, and a real Codex session successfully called its `handoff_status` tool. Inline export/import/ack and protocol handling are covered by automated tests.

Native export/import skills passed the Skill Creator frontmatter validator. Installation preserved preexisting Claude settings and unrelated integrations.

Private native transcripts, user settings, and test session IDs are excluded from this repository.
