const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = '/home/katherine/.openclaw';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'derived-history-index.json');
const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeRead(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function fileStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fmtMoney(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Number(n.toFixed(6));
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function summarise(text, max = 280) {
  const clean = cleanText(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function buildSearchText(parts) {
  return parts.filter(Boolean).join(' \n ').toLowerCase();
}

function pickRecentTs(item) {
  return item.lastAt || item.startedAt || item.createdAt || item.archiveAt || item.updatedAt || null;
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

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function normaliseUsage(usageTotals) {
  return {
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
  };
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

function loadSessionEvents(sessionFile) {
  const raw = safeRead(sessionFile).trim();
  if (!raw) return [];
  return raw
    .split(/\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getMessageText(event) {
  if (!event || event.type !== 'message') return '';
  return extractPrimaryText(event.message);
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

function firstUserText(events) {
  for (const event of events) {
    if (event.type === 'message' && event.message?.role === 'user') {
      const text = extractPrimaryText(event.message);
      if (text) return text;
    }
  }
  return '';
}

function sessionTypeFromKey(sessionKey = '') {
  if (sessionKey.includes(':subagent:')) return 'subagent';
  if (sessionKey.includes(':telegram:')) return 'telegram';
  if (sessionKey.includes(':discord:')) return 'discord';
  if (sessionKey.includes(':slack:')) return 'slack';
  if (sessionKey.endsWith(':main') || sessionKey === 'agent:main:main') return 'main';
  return 'session';
}

function inferTaskUnit({ sessionKey, sessionEntry, userPrompt, finalOutput, explicitTask, cronSummary }) {
  const explicit = cleanText(explicitTask || '');
  if (explicit) return explicit;

  const user = cleanText(userPrompt || '');
  const cron = cleanText(cronSummary || '');
  const final = cleanText(finalOutput || '');

  const patterns = [
    /\[Subagent Task\]:\s*([\s\S]+)/i,
    /\bTask:\s*([\s\S]+)/i,
    /\bObjective:\s*([\s\S]+)/i,
    /\bPlease\s+([^\n]{10,240})/i,
    /\bNeed to\s+([^\n]{10,240})/i
  ];

  for (const text of [user, cron, final]) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return summarise(match[1], 240);
    }
  }

  if (user) return summarise(user, 240);
  if (cron) return summarise(cron, 240);
  if (final) return summarise(final, 240);
  return sessionEntry?.label || sessionKey || 'session activity';
}

function inferStatus({ sessionFile, sessionEntry, finalOutput, archiveAt, cronStatus }) {
  if (cronStatus) return cronStatus;
  if (sessionFile && fs.existsSync(`${sessionFile}.lock`)) return 'running';
  if (finalOutput) return 'completed';
  if (sessionEntry?.abortedLastRun) return 'aborted';
  if (archiveAt && new Date(archiveAt).getTime() < Date.now()) return 'archived';
  if (sessionFile) return 'partial';
  return 'observed';
}

function inferConfidence(flags = []) {
  const score = Math.max(0, Math.min(1, flags.reduce((n, value) => n + value, 0)));
  if (score >= 0.85) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function buildBaseRecord(input) {
  const record = {
    id: input.id,
    label: input.label || input.id,
    sourceType: input.sourceType,
    inferredTaskUnit: input.inferredTaskUnit || '',
    status: input.status,
    confidence: input.confidence,
    model: input.model || null,
    requester: input.requester || null,
    childSessionKey: input.childSessionKey || null,
    sessionId: input.sessionId || null,
    createdAt: input.createdAt || null,
    startedAt: input.startedAt || null,
    lastAt: input.lastAt || null,
    archiveAt: input.archiveAt || null,
    updatedAt: input.updatedAt || null,
    taskSummary: summarise(input.taskRaw || input.inferredTaskUnit || '', 220),
    inputSummary: summarise(input.inputRaw || '', 280),
    outputSummary: summarise(input.outputRaw || '', 280),
    taskRaw: input.taskRaw || '',
    inputRaw: input.inputRaw || '',
    outputRaw: input.outputRaw || '',
    usage: input.usage || normaliseUsage(emptyUsage()),
    eventCount: input.eventCount || 0,
    toolCallCount: input.toolCallCount || 0,
    sourceFiles: (input.sourceFiles || []).filter(Boolean),
    notes: input.notes || []
  };

  record.searchText = buildSearchText([
    record.label,
    record.status,
    record.sourceType,
    record.confidence,
    record.requester,
    record.childSessionKey,
    record.sessionId,
    record.inferredTaskUnit,
    record.taskRaw,
    record.inputRaw,
    record.outputRaw,
    ...(record.notes || [])
  ]);

  return record;
}

function collectSessionFacts(sessionFile) {
  const events = sessionFile && fs.existsSync(sessionFile) ? loadSessionEvents(sessionFile) : [];
  const usageTotals = emptyUsage();
  let toolCallCount = 0;

  for (const event of events) {
    if (event?.type === 'message' && event.message?.role === 'assistant') {
      sumUsage(usageTotals, event.message.usage);
      toolCallCount += (event.message.content || []).filter((part) => part.type === 'toolCall').length;
    }
  }

  const timestamps = events.map((event) => event.timestamp).filter(Boolean).sort();
  const userPrompt = firstUserText(events);
  const finalOutput = extractAssistantFinal(events);

  return {
    events,
    eventCount: events.length,
    toolCallCount,
    usage: normaliseUsage(usageTotals),
    firstAt: timestamps[0] || null,
    lastAt: timestamps[timestamps.length - 1] || null,
    userPrompt,
    finalOutput
  };
}

function buildSubagentRunRecords(runs, sessionsMap) {
  const knownSessionKeys = new Set();
  const items = [];

  for (const [runId, runMeta] of Object.entries(runs || {})) {
    const childKey = runMeta.childSessionKey;
    if (childKey) knownSessionKeys.add(childKey);
    const sessionEntry = sessionsMap[childKey] || {};
    const sessionFile = sessionEntry.sessionFile;
    const facts = collectSessionFacts(sessionFile);
    const inferredTaskUnit = inferTaskUnit({
      sessionKey: childKey,
      sessionEntry,
      userPrompt: facts.userPrompt,
      finalOutput: facts.finalOutput,
      explicitTask: runMeta.task
    });

    items.push(buildBaseRecord({
      id: runId,
      label: runMeta.label || childKey || runId,
      sourceType: 'subagent-run',
      inferredTaskUnit,
      status: inferStatus({
        sessionFile,
        sessionEntry,
        finalOutput: facts.finalOutput,
        archiveAt: runMeta.archiveAtMs ? new Date(runMeta.archiveAtMs).toISOString() : null
      }),
      confidence: inferConfidence([
        childKey ? 0.35 : 0,
        runMeta.task ? 0.2 : 0,
        sessionFile ? 0.2 : 0,
        facts.finalOutput ? 0.15 : 0,
        facts.eventCount ? 0.1 : 0
      ]),
      model: runMeta.model || sessionEntry.model,
      requester: runMeta.requesterDisplayKey || runMeta.requesterSessionKey || sessionEntry.spawnedBy || null,
      childSessionKey: childKey,
      sessionId: sessionEntry.sessionId || null,
      createdAt: runMeta.createdAt ? new Date(runMeta.createdAt).toISOString() : null,
      startedAt: runMeta.startedAt ? new Date(runMeta.startedAt).toISOString() : facts.firstAt,
      lastAt: facts.lastAt,
      archiveAt: runMeta.archiveAtMs ? new Date(runMeta.archiveAtMs).toISOString() : null,
      updatedAt: sessionEntry.updatedAt || facts.lastAt,
      taskRaw: runMeta.task || inferredTaskUnit,
      inputRaw: facts.userPrompt,
      outputRaw: facts.finalOutput,
      usage: facts.usage,
      eventCount: facts.eventCount,
      toolCallCount: facts.toolCallCount,
      sourceFiles: [path.join(ROOT, 'subagents', 'runs.json'), path.join(ROOT, 'agents', 'main', 'sessions', 'sessions.json'), sessionFile],
      notes: ['Explicit subagent run metadata']
    }));
  }

  return { items, knownSessionKeys };
}

function looksTaskLike(text) {
  const clean = cleanText(text);
  if (!clean) return false;
  if (clean.length > 20) return true;
  return /task|fix|build|review|write|create|update|run|check|inspect|summari[sz]e|analyse|analyze/i.test(clean);
}

function buildSessionRecords(sessionsMap, knownSessionKeys) {
  const items = [];
  const sessionDir = path.join(ROOT, 'agents', 'main', 'sessions');
  if (!fs.existsSync(sessionDir)) return items;

  const activeById = new Map();
  for (const [sessionKey, sessionEntry] of Object.entries(sessionsMap || {})) {
    if (sessionEntry?.sessionId) activeById.set(sessionEntry.sessionId, { sessionKey, sessionEntry });
  }

  const names = fs.readdirSync(sessionDir)
    .filter((name) => name.includes('.jsonl'))
    .sort();

  for (const name of names) {
    const sessionFile = path.join(sessionDir, name);
    if (!fs.statSync(sessionFile).isFile()) continue;

    const sessionId = name.split('.jsonl')[0];
    const active = activeById.get(sessionId) || {};
    const sessionKey = active.sessionKey || sessionId;
    const sessionEntry = active.sessionEntry || {};
    if (knownSessionKeys.has(sessionKey) || knownSessionKeys.has(sessionEntry.sessionId)) continue;

    const facts = collectSessionFacts(sessionFile);
    const firstUser = facts.userPrompt;
    const spawnedPattern = sessionKey.includes(':subagent:') || sessionEntry.subagentRole != null || sessionEntry.spawnDepth != null || sessionEntry.spawnedBy || name.includes('.deleted.') || name.includes('.reset.');
    const taskLike = looksTaskLike(firstUser) || looksTaskLike(facts.finalOutput);
    if (!spawnedPattern && !taskLike) continue;

    const sourceType = name.includes('.deleted.') || name.includes('.reset.')
      ? 'historical-session'
      : spawnedPattern
        ? 'spawned-session'
        : sessionTypeFromKey(sessionKey) === 'main'
          ? 'main-session'
          : 'session-trace';

    const inferredTaskUnit = inferTaskUnit({
      sessionKey,
      sessionEntry,
      userPrompt: firstUser,
      finalOutput: facts.finalOutput
    });

    items.push(buildBaseRecord({
      id: sessionEntry.sessionId || sessionId,
      label: sessionEntry.label || summarise(inferredTaskUnit, 90) || sessionKey,
      sourceType,
      inferredTaskUnit,
      status: inferStatus({ sessionFile, sessionEntry, finalOutput: facts.finalOutput }),
      confidence: inferConfidence([
        spawnedPattern ? 0.35 : 0,
        taskLike ? 0.25 : 0,
        firstUser ? 0.2 : 0,
        facts.eventCount ? 0.1 : 0,
        facts.finalOutput ? 0.1 : 0
      ]),
      model: sessionEntry.model || null,
      requester: sessionEntry.spawnedBy || sessionEntry.lastTo || sessionEntry.channel || (sessionEntry.origin && JSON.stringify(sessionEntry.origin)) || null,
      childSessionKey: sessionKey,
      sessionId: sessionEntry.sessionId || sessionId,
      createdAt: facts.firstAt,
      startedAt: facts.firstAt,
      lastAt: facts.lastAt,
      archiveAt: null,
      updatedAt: sessionEntry.updatedAt || facts.lastAt,
      taskRaw: inferredTaskUnit,
      inputRaw: firstUser,
      outputRaw: facts.finalOutput,
      usage: facts.usage,
      eventCount: facts.eventCount,
      toolCallCount: facts.toolCallCount,
      sourceFiles: [path.join(ROOT, 'agents', 'main', 'sessions', 'sessions.json'), sessionFile],
      notes: [name.includes('.deleted.') || name.includes('.reset.') ? 'Historical JSONL trace inferred' : (spawnedPattern ? 'Spawn/session metadata inferred' : 'Task-like JSONL trace inferred')]
    }));
  }

  return items;
}

function buildCronRecords() {
  const items = [];
  const jobsFile = path.join(ROOT, 'cron', 'jobs.json');
  const jobsData = readJson(jobsFile, { version: 1, jobs: [] }) || { version: 1, jobs: [] };
  const jobs = new Map((jobsData.jobs || []).map((job) => [job.id, job]));
  const runsDir = path.join(ROOT, 'cron', 'runs');
  if (!fs.existsSync(runsDir)) return items;

  for (const name of fs.readdirSync(runsDir).filter((entry) => entry.endsWith('.jsonl')).sort()) {
    const runFile = path.join(runsDir, name);
    const rows = loadSessionEvents(runFile);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const job = jobs.get(row.jobId) || {};
      const runAt = row.runAtMs ? new Date(row.runAtMs).toISOString() : row.ts || null;
      const summary = cleanText(row.summary || job.prompt || job.name || 'cron run');
      items.push(buildBaseRecord({
        id: `${name.replace(/\.jsonl$/, '')}:${index + 1}`,
        label: job.name || row.jobId || 'cron run',
        sourceType: 'cron-run',
        inferredTaskUnit: inferTaskUnit({ cronSummary: summary, explicitTask: job.prompt || job.name || summary }),
        status: inferStatus({ cronStatus: row.status || row.deliveryStatus || row.action || 'observed' }),
        confidence: inferConfidence([
          row.jobId ? 0.35 : 0,
          row.sessionKey || row.sessionId ? 0.25 : 0,
          summary ? 0.2 : 0,
          row.status ? 0.1 : 0,
          row.runAtMs || row.ts ? 0.1 : 0
        ]),
        model: job.model || null,
        requester: job.target || job.channel || null,
        childSessionKey: row.sessionKey || null,
        sessionId: row.sessionId || null,
        createdAt: runAt,
        startedAt: runAt,
        lastAt: row.ts || runAt,
        updatedAt: row.ts || runAt,
        taskRaw: summary,
        inputRaw: job.prompt || '',
        outputRaw: row.deliveryStatus ? `${row.action || 'delivery'} • ${row.deliveryStatus}` : (row.summary || ''),
        usage: normaliseUsage(emptyUsage()),
        eventCount: 1,
        toolCallCount: 0,
        sourceFiles: [jobsFile, runFile],
        notes: ['Cron/job history row']
      }));
    }
  }

  return items;
}

function dedupeItems(items) {
  const best = new Map();
  const rank = { 'subagent-run': 5, 'spawned-session': 4, 'cron-run': 3, 'main-session': 2, 'session-trace': 1 };

  for (const item of items) {
    const key = item.sessionId || item.childSessionKey || `${item.sourceType}:${item.id}`;
    const current = best.get(key);
    if (!current) {
      best.set(key, item);
      continue;
    }
    const currentRank = rank[current.sourceType] || 0;
    const nextRank = rank[item.sourceType] || 0;
    if (nextRank > currentRank || ((item.eventCount || 0) > (current.eventCount || 0))) {
      best.set(key, item);
    }
  }

  return Array.from(best.values());
}

function computeSummary(items) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const summary = {
    runs: 0,
    statuses: {},
    sourceTypes: {},
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
    summary.sourceTypes[item.sourceType] = (summary.sourceTypes[item.sourceType] || 0) + 1;
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

function collectInputFiles() {
  const files = [
    path.join(ROOT, 'subagents', 'runs.json'),
    path.join(ROOT, 'agents', 'main', 'sessions', 'sessions.json'),
    path.join(ROOT, 'cron', 'jobs.json')
  ];

  const sessionDir = path.join(ROOT, 'agents', 'main', 'sessions');
  if (fs.existsSync(sessionDir)) {
    for (const name of fs.readdirSync(sessionDir)) {
      if (name.includes('.jsonl')) files.push(path.join(sessionDir, name));
    }
  }

  const cronRunsDir = path.join(ROOT, 'cron', 'runs');
  if (fs.existsSync(cronRunsDir)) {
    for (const name of fs.readdirSync(cronRunsDir)) {
      if (name.endsWith('.jsonl')) files.push(path.join(cronRunsDir, name));
    }
  }

  return files.filter((file) => fs.existsSync(file)).sort();
}

function buildInputSignature(files) {
  return files.map((file) => {
    const stat = fileStat(file);
    return {
      file,
      size: stat?.size || 0,
      mtimeMs: stat?.mtimeMs || 0
    };
  });
}

function buildIndex() {
  const runs = readJson(path.join(ROOT, 'subagents', 'runs.json'), { runs: {} })?.runs || {};
  const sessionsMap = readJson(path.join(ROOT, 'agents', 'main', 'sessions', 'sessions.json'), {}) || {};
  const { items: subagentRuns, knownSessionKeys } = buildSubagentRunRecords(runs, sessionsMap);
  const sessionItems = buildSessionRecords(sessionsMap, knownSessionKeys);
  const cronItems = buildCronRecords();
  const items = dedupeItems([...subagentRuns, ...sessionItems, ...cronItems]).sort((a, b) => {
    const ta = new Date(pickRecentTs(a) || 0).getTime();
    const tb = new Date(pickRecentTs(b) || 0).getTime();
    return tb - ta;
  });
  const summary = computeSummary(items);
  const inputFiles = collectInputFiles();

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    cacheFile: CACHE_FILE,
    cacheMode: 'derived-local-read-only',
    totals: {
      runs: summary.runs,
      statuses: summary.statuses,
      sourceTypes: summary.sourceTypes,
      totalTokens: summary.totalTokens,
      totalCost: summary.totalCost
    },
    summary,
    inputSignature: buildInputSignature(inputFiles),
    items
  };
}

function signaturesEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function loadDerivedData() {
  const liveSignature = buildInputSignature(collectInputFiles());
  const cached = readJson(CACHE_FILE, null);
  if (cached && signaturesEqual(cached.inputSignature, liveSignature)) {
    return { ...cached, cacheStatus: 'hit' };
  }

  const built = buildIndex();
  ensureDir(CACHE_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(built, null, 2));
  return { ...built, cacheStatus: cached ? 'refreshed' : 'built' };
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
      return sendJson(res, loadDerivedData());
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message }, null, 2));
    }
  }

  const filePath = parsed.pathname === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, parsed.pathname.replace(/^\//, ''));

  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Mission Control running at http://${HOST}:${PORT}`);
});
