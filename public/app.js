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

function metric(label, value) {
  return `<div><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
}

function smallMetric(label, value) {
  return `<div class="metric"><div class="metric-label">${label}</div><div>${value}</div></div>`;
}

function kv(label, value) {
  return `<dl class="kv"><dt>${label}</dt><dd>${value || '—'}</dd></dl>`;
}

async function load() {
  const res = await fetch('/api/runs', { cache: 'no-store' });
  const data = await res.json();

  const summary = document.getElementById('summary');
  summary.innerHTML = [
    metric('Runs', fmtNum(data.totals.runs)),
    metric('Completed', fmtNum(data.totals.statuses.completed || 0)),
    metric('Running', fmtNum(data.totals.statuses.running || 0)),
    metric('Total tokens', fmtNum(data.totals.totalTokens || 0)),
    metric('Observed spend', fmtCost(data.totals.totalCost)),
    metric('Generated', fmtDate(data.generatedAt))
  ].join('');

  const runs = document.getElementById('runs');
  runs.innerHTML = '';
  if (!data.items.length) {
    runs.innerHTML = '<div class="empty">No sub-agent runs found.</div>';
    return;
  }

  const template = document.getElementById('runTemplate');
  for (const item of data.items) {
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

document.getElementById('refreshBtn').addEventListener('click', load);
load().catch((error) => {
  document.getElementById('runs').innerHTML = `<div class="empty">Failed to load data: ${error.message}</div>`;
});
