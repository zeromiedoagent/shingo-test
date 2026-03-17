# shingo-test

Simple local-only read-only Mission Control viewer for OpenClaw sub-agent runs.

## What it does

- reads existing local OpenClaw history files
- treats sub-agent runs as the primary unit
- shows status, timestamps, task/input/output summaries
- exposes raw task/input/output in expandable sections
- shows token and cost data where present in session history
- gives basic historical visibility across current and older sub-agent sessions

## Data sources

- `/home/katherine/.openclaw/subagents/runs.json`
- `/home/katherine/.openclaw/agents/main/sessions/sessions.json`
- matching per-session `.jsonl` files under `/home/katherine/.openclaw/agents/main/sessions/`

## Run locally

```bash
cd /home/katherine/shingo-test
npm start
```

Then open:

- `http://127.0.0.1:3210`

## Notes / limits

- local-only by default: binds to `127.0.0.1`
- read-only: does not modify OpenClaw history
- v1 is intentionally basic and file-driven
- spend/tokens only appear when recorded in the session JSONL usage blocks
- this currently focuses on sub-agent sessions and orphaned historic sub-agent session entries; it does not attempt to model every non-subagent OpenClaw session type
