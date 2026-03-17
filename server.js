const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = '/home/katherine/.openclaw';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeRead(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function fmtMoney(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Number(n.toFixed(6));
}

function sumUsage(target, usage) {
  if (!usage) return;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (typeof usage[key] === 'number') target[key] += usage[key];
  }
  const cost = usage.cost || {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    if (typeof cost[key] === 'number') target.cost[key] += cost[key];
  }
}

function extractTextParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && (part.type === 'text' || part.type === 'summary_text'))
    .map((part) => part.text)
    .filter(Boolean);
}

function extractPrimaryText(message) {
  return extractTextParts(message?.content).join('\n\n').trim();
}

function extractUserPrompt(events) {
  for (const event of events) {
    const msg = event?.message;
    if (event.type === 'message' && msg?.role === 'user') {
      const text = extractPrimaryText(msg);
      if (text) return text;
    }
  }
  return '';
}

function extractAssistantFinal(events) {
  let best = '';
  for (const event of events) {
    const msg = event?.message;
    if (event.type !== 'message' || msg?.role !== 'assistant') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const final = content.find((part) => part?.textSignature?.phase === 'final_answer' && part?.text);
    if (final?.text) best = final.text.trim();
  }
  if (best) return best;
  for (let i = events.length - 1; i >= 0; i--) {
    const msg = events[i]?.message;
    if (events[i]?.type === 'message' && msg?.role === 'assistant') {
      const text = extractPrimaryText(msg);
      if (text) return text;
    }
  }
  return '';
}

function summarise(text, max = 280) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function sessionStatus(run, sessionEntry, sessionFile, finalOutput) {
  const lockFile = `${sessionFile}.lock`;
  if (fs.existsSync(lockFile)) return 'running';
  if (finalOutput) return 'completed';
  if (run?.archiveAtMs && run.archiveAtMs < Date.now()) return 'archived';
  if (sessionEntry?.abortedLastRun) return 'aborted';
  return 'partial';
}

function loadSessionEvents(sessionFile) {
  const raw = safeRead(sessionFile).trim();
  if (!raw) return [];
  return raw
    .split(/\n/)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function buildSearchText(parts) {
  return parts
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

function buildRunRecord(runId, runMeta, sessionsMap) {
  const childKey = runMeta.childSessionKey;
  const sessionEntry = sessionsMap[childKey] || {};
  const sessionFile = sessionEntry.sessionFile;
  const events = sessionFile && fs.existsSync(sessionFile) ? loadSessionEvents(sessionFile) : [];
  const userPrompt = extractUserPrompt(events);
  const finalOutput = extractAssistantFinal(events);
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  for (const event of events) {
    const msg = event?.message;
    if (event?.type === 'message' && msg?.role === 'assistant') {
      sumUsage(usageTotals, msg.usage);
    }
  }

  const timestamps = events.map((e) => e.timestamp).filter(Boolean).sort();
  const startedAt = runMeta.startedAt ? new Date(runMeta.startedAt).toISOString() : timestamps[0] || null;
  const lastAt = timestamps[timestamps.length - 1] || null;
  const status = sessionFile ? sessionStatus(runMeta, sessionEntry, sessionFile, finalOutput) : 'missing';

  const record = {
    id: runId,
    label: runMeta.label || childKey,
    status,
    model: runMeta.model || sessionEntry.model || null,
    requester: runMeta.requesterDisplayKey || runMeta.requesterSessionKey || null,
    childSessionKey: childKey,
    sessionId: sessionEntry.sessionId || null,
    createdAt: runMeta.createdAt ? new Date(runMeta.createdAt).toISOString() : null,
    startedAt,
    lastAt,
    archiveAt: runMeta.archiveAtMs ? new Date(runMeta.archiveAtMs).toISOString() : null,
    taskSummary: summarise(runMeta.task, 220),
    inputSummary: summarise(userPrompt, 280),
    outputSummary: summarise(finalOutput, 280),
    taskRaw: runMeta.task || '',
    inputRaw: userPrompt,
    outputRaw: finalOutput,
    usage: {
      input: usageTotals.input || null,
      output: usageTotals.output || null,
      cacheRead: usageTotals.cacheRead || null,
      cacheWrite: usageTotals.cacheWrite || null,
      totalTokens: usageTotals.totalTokens || null,
      cost: {
        input: fmtMoney(usageTotals.cost.input),
        output: fmtMoney(usageTotals.cost.output),
        cacheRead: fmtMoney(usageTotals.cost.cacheRead),
        cacheWrite: fmtMoney(usageTotals.cost.cacheWrite),
        total: fmtMoney(usageTotals.cost.total)
      }
    },
    eventCount: events.length,
    toolCallCount: events.filter((e) => e.type === 'message' && e.message?.role === 'assistant').reduce((n, e) => n + ((e.message.content || []).filter((p) => p.type === 'toolCall').length), 0),
    sourceFiles: [
      '/home/katherine/.openclaw/subagents/runs.json',
      '/home/katherine/.openclaw/agents/main/sessions/sessions.json',
      sessionFile
    ].filter(Boolean)
  };

  record.searchText = buildSearchText([
    record.label,
    record.status,
    record.requester,
    record.childSessionKey,
    record.sessionId,
    record.taskRaw,
    record.inputRaw,
    record.outputRaw
  ]);

  return record;
}

function buildOrphanSubagentRecords(sessionsMap, knownSessionKeys) {
  const rows = [];
  for (const [sessionKey, sessionEntry] of Object.entries(sessionsMap)) {
    if (!sessionKey.includes(':subagent:') && sessionEntry.subagentRole !== 'leaf' && sessionEntry.spawnDepth == null) continue;
    if (knownSessionKeys.has(sessionKey)) continue;
    const sessionFile = sessionEntry.sessionFile;
    if (!sessionFile || !fs.existsSync(sessionFile)) continue;
    const events = loadSessionEvents(sessionFile);
    const userPrompt = extractUserPrompt(events);
    const finalOutput = extractAssistantFinal(events);
    const timestamps = events.map((e) => e.timestamp).filter(Boolean).sort();
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    for (const event of events) {
      const msg = event?.message;
      if (event?.type === 'message' && msg?.role === 'assistant') sumUsage(usageTotals, msg.usage);
    }
    const record = {
      id: sessionEntry.sessionId || sessionKey,
      label: sessionEntry.label || sessionKey,
      status: sessionStatus(null, sessionEntry, sessionFile, finalOutput),
      model: sessionEntry.model || null,
      requester: sessionEntry.spawnedBy || null,
      childSessionKey: sessionKey,
      sessionId: sessionEntry.sessionId || null,
      createdAt: null,
      startedAt: timestamps[0] || null,
      lastAt: timestamps[timestamps.length - 1] || null,
      archiveAt: null,
      taskSummary: summarise(userPrompt, 220),
      inputSummary: summarise(userPrompt, 280),
      outputSummary: summarise(finalOutput, 280),
      taskRaw: userPrompt,
      inputRaw: userPrompt,
      outputRaw: finalOutput,
      usage: {
        input: usageTotals.input || null,
        output: usageTotals.output || null,
        cacheRead: usageTotals.cacheRead || null,
        cacheWrite: usageTotals.cacheWrite || null,
        totalTokens: usageTotals.totalTokens || null,
        cost: {
          input: fmtMoney(usageTotals.cost.input),
          output: fmtMoney(usageTotals.cost.output),
          cacheRead: fmtMoney(usageTotals.cost.cacheRead),
          cacheWrite: fmtMoney(usageTotals.cost.cacheWrite),
          total: fmtMoney(usageTotals.cost.total)
        }
      },
      eventCount: events.length,
      toolCallCount: events.filter((e) => e.type === 'message' && e.message?.role === 'assistant').reduce((n, e) => n + ((e.message.content || []).filter((p) => p.type === 'toolCall').length), 0),
      sourceFiles: [sessionFile]
    };
    record.searchText = buildSearchText([
      record.label,
      record.status,
      record.requester,
      record.childSessionKey,
      record.sessionId,
      record.taskRaw,
      record.inputRaw,
      record.outputRaw
    ]);
    rows.push(record);
  }
  return rows;
}

function pickRecentTs(item) {
  return item.lastAt || item.startedAt || item.createdAt || item.archiveAt || null;
}

function computeSummary(items) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const summary = {
    runs: 0,
    statuses: {},
    totalTokens: 0,
    totalCost: 0,
    todayRuns: 0,
    runningNow: 0,
    completedToday: 0,
    updatedLastHour: 0,
    recent24h: 0,
    activeStatuses: 0,
    requesters: new Set()
  };

  for (const item of items) {
    summary.runs += 1;
    summary.statuses[item.status] = (summary.statuses[item.status] || 0) + 1;
    summary.totalTokens += item.usage.totalTokens || 0;
    summary.totalCost += item.usage.cost.total || 0;
    if (item.requester) summary.requesters.add(item.requester);
    if (item.status === 'running') summary.runningNow += 1;

    const startedMs = item.startedAt ? new Date(item.startedAt).getTime() : 0;
    const recentMs = pickRecentTs(item) ? new Date(pickRecentTs(item)).getTime() : 0;

    if (startedMs >= todayMs) summary.todayRuns += 1;
    if (startedMs >= todayMs && item.status === 'completed') summary.completedToday += 1;
    if (recentMs >= now - (60 * 60 * 1000)) summary.updatedLastHour += 1;
    if (recentMs >= now - DAY_MS) summary.recent24h += 1;
  }

  summary.activeStatuses = Object.keys(summary.statuses).length;
  summary.requesterCount = summary.requesters.size;
  summary.totalCost = fmtMoney(summary.totalCost);
  delete summary.requesters;
  return summary;
}

function loadData() {
  const runsFile = path.join(ROOT, 'subagents', 'runs.json');
  const sessionsFile = path.join(ROOT, 'agents', 'main', 'sessions', 'sessions.json');
  const runs = readJson(runsFile).runs || {};
  const sessionsMap = readJson(sessionsFile);

  const knownSessionKeys = new Set();
  const subagentRuns = Object.entries(runs).map(([runId, runMeta]) => {
    knownSessionKeys.add(runMeta.childSessionKey);
    return buildRunRecord(runId, runMeta, sessionsMap);
  });

  const orphanRuns = buildOrphanSubagentRecords(sessionsMap, knownSessionKeys);
  const items = [...subagentRuns, ...orphanRuns].sort((a, b) => {
    const ta = new Date(pickRecentTs(a) || 0).getTime();
    const tb = new Date(pickRecentTs(b) || 0).getTime();
    return tb - ta;
  });

  const summary = computeSummary(items);

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    totals: {
      runs: summary.runs,
      statuses: summary.statuses,
      totalTokens: summary.totalTokens,
      totalCost: summary.totalCost
    },
    summary,
    items
  };
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data, null, 2));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : ext === '.js' ? 'application/javascript; charset=utf-8'
    : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(filePath));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '/');
  if (parsed.pathname === '/api/runs') {
    try {
      return sendJson(res, loadData());
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message }, null, 2));
    }
  }

  const filePath = parsed.pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, parsed.pathname.replace(/^\//, ''));
  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Mission Control running at http://${HOST}:${PORT}`);
});
