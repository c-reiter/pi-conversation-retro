# pi-conversation-retro

A [pi](https://github.com/badlogic/pi-mono) extension that runs automated postmortem reviews on your coding agent conversations. It identifies mistakes, analyzes root causes, and generates weekly improvement reports.

## What it does

1. **Discovers** recent pi session files related to the current repo (via `git rev-parse --show-toplevel`)
2. **Skips** sessions that already have a summary markdown file
3. **Spawns** one reviewer subagent per remaining session to analyze mistakes
4. **Writes** one markdown summary per session
5. **Synthesizes** all in-scope summaries into a workflow improvement report

## Install

```bash
pi install npm:pi-conversation-retro
# or
pi install git:github.com/c-reiter/pi-conversation-retro
```

## Usage

In any pi session, run:

```
/conversation-retro
```

### Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--days <n>` | `-d` | `7` | Number of days to look back |
| `--concurrency <n>` | `-c` | `10` | Max concurrent reviewer subagents |
| `--timeout <minutes>` | `-t` | `12` | Timeout per subagent (minutes) |
| `--output <path>` | `-o` | `.pi/reports/conversation-retro` | Output directory (absolute or repo-relative) |
| `--limit <n>` | `-l` | — | Cap newly analyzed conversations per run |
| `--dry-run` | — | — | Discover and count only, no subagents |

### Examples

```
/conversation-retro --days 14 --concurrency 4
/conversation-retro --dry-run
/conversation-retro --limit 5 --output reports/retro
```

## Output

All output goes to `.pi/reports/conversation-retro/` by default:

- **Per-conversation summaries:** `<session-file-name>.md` — mistake analysis for each session
- **Improvement report:** `workflow-improvement-report-<timestamp>.md` — synthesized patterns and action items
- **Latest report:** `workflow-improvement-report-latest.md` — always points to the most recent report

### Per-conversation summary sections

- Snapshot
- What went wrong
- Root causes
- Recommended fixes
- Quick prevention checklist

### Improvement report sections

- Executive summary
- Recurring failure patterns
- Process improvements
- Documentation/instruction improvements
- Repo/tooling structure improvements
- Prioritized action plan (next 7 days)
- Metrics to track

## How it works

The extension registers a `/conversation-retro` slash command. When invoked, it:

1. Finds all `.jsonl` session files under `~/.pi/agent/sessions/` whose `cwd` header points inside the current git repo
2. Filters to sessions created within the `--days` window
3. Skips sessions that already have a corresponding `.md` summary in the output directory
4. Spawns pi subagents in print mode (`pi -p --no-session`) with read-only tools to analyze each session
5. Runs the analyses concurrently (up to `--concurrency`) with per-agent timeouts
6. Collects all summaries (including previously generated ones) and spawns a final reviewer subagent
7. The reviewer synthesizes recurring patterns into an actionable improvement report

Progress is shown via a TUI widget and status bar during execution.

## License

MIT
