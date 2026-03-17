const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = '/home/katherine/.openclaw';
const PUBLIC_DIR = path.join(__dirname, 'public');

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

  return {
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
    rows.push({
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
    });
  }
  return rows;
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
    const ta = new Date(a.startedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.startedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  const totals = items.reduce((acc, item) => {
    acc.runs += 1;
    acc.statuses[item.status] = (acc.statuses[item.status] || 0) + 1;
    acc.totalTokens += item.usage.totalTokens || 0;
    acc.totalCost += item.usage.cost.total || 0;
    return acc;
  }, { runs: 0, statuses: {}, totalTokens: 0, totalCost: 0 });

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    totals: { ...totals, totalCost: fmtMoney(totals.totalCost) },
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
