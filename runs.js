const $ = (id) => document.getElementById(id);

function formatTime(durationSeconds) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return '—';
  const m = Math.floor(durationSeconds / 60);
  const s = String(durationSeconds % 60).padStart(2, '0');
  return `${m}m${s}s`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '<',
    '>': '>',
    '"': '"',
    "'": '&#039;',
  }[s]));
}

function safeText(x) {
  return x == null ? '' : String(x);
}

function makeRankBadge(rank) {
  const cls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  return `<span class="global-rank ${cls}">${rank}</span>`;
}

async function loadTopRuns({ limit, windowDays }) {
  const meta = $('meta');
  const status = $('status');
  const errorBox = $('errorBox');
  const tbody = $('rows');
  const generatedMeta = $('generatedMeta');

  tbody.innerHTML = '';
  errorBox.hidden = true;

  status.textContent = 'Chargement…';
  meta.textContent = `Fenêtre: ${windowDays} jours • limite: ${limit}`;

  const startedAt = Date.now();

  try {
    const url = `/api/top-runs?limit=${encodeURIComponent(limit)}&windowDays=${encodeURIComponent(windowDays)}`;
    const res = await fetch(url, { cache: 'no-store' });

    if (!res.ok) {
      // tente de remonter le body si possible
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {}
      throw new Error(`HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ''}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(
        [data.errorName ? `${data.errorName}` : null, data.error ? `${data.error}` : null]
          .filter(Boolean)
          .join(': ') || 'API error'
      );
    }

    const runs = Array.isArray(data.runs) ? data.runs : [];
    status.textContent = runs.length ? '' : 'Aucun run trouvé (augmente windowDays ou réessaie).';

    const frag = document.createDocumentFragment();
    runs.forEach((r, idx) => {
      const rank = idx + 1;

      const tr = document.createElement('tr');

      const tdRank = document.createElement('td');
      tdRank.className = 'global-rank-wrap';
      tdRank.innerHTML = makeRankBadge(rank);

      const tdPlayer = document.createElement('td');
      tdPlayer.className = 'global-player';
      tdPlayer.innerHTML = `<a href="${r.url || '#'}" target="_blank" rel="noreferrer">${escapeHtml(r.player || '—')}</a>`;

      const tdMap = document.createElement('td');
      tdMap.innerHTML = `<span class="run-diff">${escapeHtml(r.map || '—')}</span>`;

      const tdTime = document.createElement('td');
      tdTime.innerHTML = `<span class="run-time">${escapeHtml(formatTime(r.duration_s))}</span>`;

      const tdDiff = document.createElement('td');
      tdDiff.textContent = safeText(r.difficulty) || '—';

      const tdPlayers = document.createElement('td');
      tdPlayers.textContent = String(r.players ?? '');

      const tdDate = document.createElement('td');
      tdDate.textContent = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';

      tr.append(tdRank, tdPlayer, tdMap, tdTime, tdDiff, tdPlayers, tdDate);
      frag.appendChild(tr);
    });

    tbody.appendChild(frag);

    const genAt = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '';
    const ms = Date.now() - startedAt;

    meta.textContent = '';
    generatedMeta.textContent = `Top ${runs.length}/${limit} • généré: ${genAt} • ${ms}ms`;
  } catch (e) {
    status.textContent = '';
    const message = e?.message || String(e);

    errorBox.hidden = false;
    errorBox.innerHTML = `
      <div class="runs-error-title">Erreur</div>
      <div class="runs-error-msg">${escapeHtml(message)}</div>
    `;

    meta.textContent = '';
    generatedMeta.textContent = '';
  }
}

function readControls() {
  const limit = Number($('limit')?.value ?? 20);
  const windowDays = Number($('windowDays')?.value ?? 30);

  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20,
    windowDays: Number.isFinite(windowDays) ? Math.max(1, Math.min(370, windowDays)) : 30,
  };
}

async function bootstrapRunsPage() {
  const { limit, windowDays } = readControls();
  await loadTopRuns({ limit, windowDays });

  $('refreshBtn')?.addEventListener('click', async () => {
    const v = readControls();
    await loadTopRuns(v);
  });

  // Enter sur les inputs déclenche refresh
  ['limit', 'windowDays'].forEach((id) => {
    $(id)?.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Enter') {
        const v = readControls();
        await loadTopRuns(v);
      }
    });
  });
}

bootstrapRunsPage();
