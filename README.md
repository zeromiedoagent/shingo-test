# shingo-test

Simple local-only read-only Mission Control viewer for OpenClaw history.

## What it does

- reads existing local OpenClaw history files
- reconstructs historical runs from more than explicit sub-agent markers
- indexes:
  - explicit sub-agent runs from `subagents/runs.json`
  - spawned sessions even when metadata is incomplete
  - main/session JSONL traces that look task-like
  - cron/job history rows when present
- writes a local derived cache/index for fast repeated loads
- shows source type, inferred task unit, timestamps, status, confidence, tokens, cost, and raw task/input/output where available
- keeps the dashboard read-only with respect to OpenClaw history
- supports summary cards, status/source/time filters, free-text search, and auto-refresh

## Data sources

- `/home/katherine/.openclaw/subagents/runs.json`
- `/home/katherine/.openclaw/agents/main/sessions/sessions.json`
- per-session `.jsonl` files under `/home/katherine/.openclaw/agents/main/sessions/`
- `/home/katherine/.openclaw/cron/jobs.json`
- per-run cron history under `/home/katherine/.openclaw/cron/runs/`

## Derived local cache

The app builds and refreshes a local-only derived index at:

- `/home/katherine/shingo-test/data/derived-history-index.json`

It refreshes when the observed input file signature changes.

## Run locally

```bash
cd /home/katherine/shingo-test
npm start
```

Then open:

- `http://127.0.0.1:3210`

## Notes / limits

- local-only by default: binds to `127.0.0.1`
- read-only toward OpenClaw history: the app only reads OpenClaw files and writes its own local derived cache
- reconstruction is heuristic outside explicit sub-agent metadata
- confidence is qualitative (`high` / `medium` / `low`) based on how much evidence was available
- spend/tokens only appear when recorded in source session history
- cron history may be sparse depending on what OpenClaw retained
- search is simple substring matching over a prebuilt lower-cased index
- task-unit inference prefers explicit task text, then task-like user prompts, then fallback summaries
