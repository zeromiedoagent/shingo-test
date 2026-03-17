const AUTO_REFRESH_MS = 15000;

const state = {
  data: null,
  timer: null,
  lastLoadedAt: null
};

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function fmtNum(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function fmtCost(value) {
  return typeof value === 'number' ? `$${value.toFixed(6)}` : '—';
}

function metric(label, value, note = '') {
  return `<div class="summary-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div>${note ? `<div class="metric-note">${note}</div>` : ''}</div>`;
}

function smallMetric(label, value) {
  return `<div class="metric"><div class="metric-label">${label}</div><div>${value}</div></div>`;
}

function kv(label, value) {
  return `<dl class="kv"><dt>${label}</dt><dd>${value || '—'}</dd></dl>`;
}

function getRecentTs(item) {
  return item.lastAt || item.startedAt || item.createdAt || item.archiveAt || null;
}

function matchesTimeFilter(item, filter) {
  if (filter === 'all') return true;
  const ts = getRecentTs(item);
  if (!ts) return false;
  const time = new Date(ts).getTime();
  const now = Date.now();

  if (filter === 'today') {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return time >= dayStart.getTime();
  }
  if (filter === '24h') return time >= now - (24 * 60 * 60 * 1000);
  if (filter === '7d') return time >= now - (7 * 24 * 60 * 60 * 1000);
  return true;
}

function applyFilters(items) {
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const status = document.getElementById('statusFilter').value;
  const time = document.getElementById('timeFilter').value;

  return items.filter((item) => {
    if (status !== 'all' && item.status !== status) return false;
    if (!matchesTimeFilter(item, time)) return false;
    if (search && !String(item.searchText || '').includes(search)) return false;
    return true;
  });
}

function renderSummary(data, filteredItems) {
  const summary = document.getElementById('summary');
  const s = data.summary || data.totals || {};
  summary.innerHTML = [
    metric('Visible runs', fmtNum(filteredItems.length), `${fmtNum(data.totals.runs)} total loaded`),
    metric('Running now', fmtNum(s.runningNow || 0), `${fmtNum(data.totals.statuses.running || 0)} total running`),
    metric('Today', fmtNum(s.todayRuns || 0), `${fmtNum(s.completedToday || 0)} completed today`),
    metric('Updated last hour', fmtNum(s.updatedLastHour || 0), `${fmtNum(s.recent24h || 0)} active in 24h`),
    metric('Unique requesters', fmtNum(s.requesterCount || 0), `${fmtNum(s.activeStatuses || 0)} statuses seen`),
    metric('Observed spend', fmtCost(data.totals.totalCost), `${fmtNum(data.totals.totalTokens || 0)} total tokens`),
    metric('Generated', fmtDate(data.generatedAt), state.lastLoadedAt ? `UI refreshed ${fmtDate(state.lastLoadedAt)}` : '')
  ].join('');
}

function renderRuns(items) {
  const runs = document.getElementById('runs');
  runs.innerHTML = '';
  if (!items.length) {
    runs.innerHTML = '<div class="empty">No runs match the current filters.</div>';
    return;
  }

  const template = document.getElementById('runTemplate');
  for (const item of items) {
    const node = template.content.firstElementChild.cloneNode(true);
    const statusEl = node.querySelector('.status-pill');
    statusEl.textContent = item.status;
    statusEl.classList.add(`status-${item.status}`);
    node.querySelector('.run-title').textContent = item.label || item.id;
    node.querySelector('.run-meta').textContent = `${item.childSessionKey} • started ${fmtDate(item.startedAt)} • last update ${fmtDate(item.lastAt)}`;
    node.querySelector('.metrics').innerHTML = [
      smallMetric('Tokens', fmtNum(item.usage.totalTokens)),
      smallMetric('Spend', fmtCost(item.usage.cost.total)),
      smallMetric('Tool calls', fmtNum(item.toolCallCount)),
      smallMetric('Events', fmtNum(item.eventCount))
    ].join('');
    node.querySelector('.task-summary').textContent = item.taskSummary || '—';
    node.querySelector('.input-summary').textContent = item.inputSummary || '—';
    node.querySelector('.output-summary').textContent = item.outputSummary || '—';
    node.querySelector('.task-raw').textContent = item.taskRaw || '—';
    node.querySelector('.input-raw').textContent = item.inputRaw || '—';
    node.querySelector('.output-raw').textContent = item.outputRaw || '—';
    node.querySelector('.details-grid').innerHTML = [
      kv('Run ID', item.id),
      kv('Session ID', item.sessionId),
      kv('Requester', item.requester),
      kv('Model', item.model),
      kv('Created', fmtDate(item.createdAt)),
      kv('Archive at', fmtDate(item.archiveAt)),
      kv('Input tokens', fmtNum(item.usage.input)),
      kv('Output tokens', fmtNum(item.usage.output)),
      kv('Cache read', fmtNum(item.usage.cacheRead)),
      kv('Cost total', fmtCost(item.usage.cost.total)),
      kv('Source files', item.sourceFiles.join('<br>'))
    ].join('');
    runs.appendChild(node);
  }
}

function renderFilterMeta(filteredItems) {
  const search = document.getElementById('searchInput').value.trim();
  const status = document.getElementById('statusFilter').value;
  const time = document.getElementById('timeFilter').value;
  const filters = [];
  if (status !== 'all') filters.push(`status: ${status}`);
  if (time !== 'all') filters.push(`view: ${time}`);
  if (search) filters.push(`search: “${search}”`);
  document.getElementById('resultsMeta').textContent = filters.length
    ? `${fmtNum(filteredItems.length)} visible • ${filters.join(' • ')}`
    : `${fmtNum(filteredItems.length)} visible • no filters`;

  const autoRefresh = document.getElementById('autoRefreshToggle').checked;
  document.getElementById('refreshMeta').textContent = autoRefresh
    ? `Auto-refresh every ${AUTO_REFRESH_MS / 1000}s`
    : 'Auto-refresh off';
}

function render() {
  if (!state.data) return;
  const filteredItems = applyFilters(state.data.items || []);
  renderSummary(state.data, filteredItems);
  renderRuns(filteredItems);
  renderFilterMeta(filteredItems);
}

function hydrateStatusFilter(items) {
  const select = document.getElementById('statusFilter');
  const current = select.value || 'all';
  const statuses = [...new Set(items.map((item) => item.status).filter(Boolean))].sort();
  select.innerHTML = '<option value="all">All statuses</option>' + statuses.map((status) => `<option value="${status}">${status}</option>`).join('');
  if (statuses.includes(current)) select.value = current;
  else select.value = 'all';
}

async function load() {
  const res = await fetch('/api/runs', { cache: 'no-store' });
  const data = await res.json();
  state.data = data;
  state.lastLoadedAt = new Date().toISOString();
  hydrateStatusFilter(data.items || []);
  render();
}

function setAutoRefresh(enabled) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (enabled) {
    state.timer = setInterval(() => {
      load().catch((error) => {
        document.getElementById('runs').innerHTML = `<div class="empty">Failed to auto-refresh: ${error.message}</div>`;
      });
    }, AUTO_REFRESH_MS);
  }
  renderFilterMeta(applyFilters((state.data && state.data.items) || []));
}

for (const id of ['searchInput', 'statusFilter', 'timeFilter']) {
  document.getElementById(id).addEventListener(id === 'searchInput' ? 'input' : 'change', render);
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  load().catch((error) => {
    document.getElementById('runs').innerHTML = `<div class="empty">Failed to load data: ${error.message}</div>`;
  });
});

document.getElementById('autoRefreshToggle').addEventListener('change', (event) => {
  setAutoRefresh(event.target.checked);
});

load().then(() => {
  setAutoRefresh(document.getElementById('autoRefreshToggle').checked);
}).catch((error) => {
  document.getElementById('runs').innerHTML = `<div class="empty">Failed to load data: ${error.message}</div>`;
});
