import {
  auth, db, doc, getDoc, setDoc, onAuthStateChanged,
  collection,
} from "./auth.js";
import { fetchOpenFront, parseSessionsPayload, normalizeSession } from "./openfront-client.js";

const t = window.t || ((key) => key);

let currentUser = null;
let firestoreProfile = null;
let playerClientIds = new Set();
let playerAliases = new Set();
let playerGameIds = new Set();
let playerSessionMap = new Map(); // gameId → session (pour vérifier hasWon)
let allRuns = [];
let globalLeaderboard = [];
let playerStats = {};

let apiPlayerInfo = null;
let apiSessions = [];

let aliasMap = {};

/* ── Helpers ── */

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function show(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? "block" : "none";
}

function showProfileView(view) {
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main"];
  views.forEach((id) => show(id, id === view));
}

/* ── Data loading ── */

async function loadRunsData() {
  let data;
  try {
    const [gzRes, aliasRes] = await Promise.allSettled([
      fetch(`runs.json.gz?_=${Date.now()}`),
      fetch(`player_aliases.json?_=${Date.now()}`),
    ]);
    if (aliasRes.status === "fulfilled" && aliasRes.value.ok) {
      try { aliasMap = await aliasRes.value.json(); _nameToPlayerIdCache = null; } catch(e) { console.warn("[profile] alias parse error:", e); }
    }
    if (gzRes.status === "fulfilled" && gzRes.value.ok) {
      try {
        const buf = await gzRes.value.arrayBuffer();
        const ds = new DecompressionStream("gzip");
        const out = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
        data = JSON.parse(new TextDecoder().decode(out));
      } catch(e) {
        console.warn("[profile] GZIP decompression failed, trying fallback:", e);
      }
    }
  } catch(e) { console.warn("[profile] loadRunsData fetch error:", e); }
  if (!data) {
    try {
      const r = await fetch(`runs.json?_=${Date.now()}`);
      if (!r.ok) throw new Error("runs.json HTTP " + r.status);
      data = await r.json();
    } catch(e) {
      console.error("[profile] Fallback runs.json also failed:", e);
      data = { runs: [] };
    }
  }
  allRuns = Array.isArray(data) ? data : (data.runs || []);
}

/* ── Leaderboard & matching ── */

function buildLeaderboard() {
  playerStats = {};

  // Invalidate cache so aliasMap enrichment is picked up
  _nameToPlayerIdCache = null;
  const nameToPlayerId = buildNameToPlayerId();

  // ── FIX: Inject logged-in user's aliases into aliasMap for DETERMINISTIC leaderboard ──
  // This ensures the leaderboard is computed the same way regardless of who views it.
  if (currentUser) {
    const virtualPid = '__connected_user__' + currentUser.uid;
    const allMyAliases = new Set([currentUser.name, ...playerAliases]);

    // Pre-scan runs to discover additional aliases that belong to this user
    allRuns.forEach(r => {
      if (playerGameIds.has(r.id)) {
        const session = playerSessionMap.get(r.id);
        if (session && session.hasWon === false) return;
        if (r.player) allMyAliases.add(r.player);
      }
    });

    aliasMap[virtualPid] = { name: currentUser.name, aliases: [...allMyAliases] };
    allMyAliases.forEach(alias => { nameToPlayerId[alias] = virtualPid; });

    // Also map client IDs that may appear as run.playerId
    playerClientIds.forEach(cid => {
      if (cid && !aliasMap[cid]) {
        aliasMap[cid] = { name: currentUser.name, aliases: [] };
      } else if (cid && aliasMap[cid] && aliasMap[cid].name !== currentUser.name) {
        aliasMap[cid] = { name: currentUser.name, aliases: aliasMap[cid].aliases || [] };
      }
      if (cid) nameToPlayerId[cid] = cid;
    });
  }

  allRuns.forEach((run) => {
    const name = getCanonicalPlayerName(run, nameToPlayerId);
    if (!name) return;
    if (!playerStats[name]) {
      playerStats[name] = { wins: 0, maps: new Set(), runs: [], points: 0 };
    }
    const p = playerStats[name];
    p.wins++;
    p.maps.add(run.map);
    p.runs.push({ ...run, player: name });
  });
  Object.values(playerStats).forEach((p) => {
    p.points = p.wins * 10 + p.maps.size * 5;
  });
  globalLeaderboard = Object.entries(playerStats)
    .map(([player, s]) => ({ player, points: s.points, wins: s.wins }))
    .sort((a, b) => b.points - a.points);
}

function isMyFFAWin(run) {
  if (!currentUser || !playerGameIds.has(run.id)) return false;
  const session = playerSessionMap.get(run.id);
  if (session && session.hasWon === false) return false;
  return true;
}

function getCanonicalPlayerName(run, nameToPlayerIdOverride) {
  // aliasMap is the SINGLE SOURCE OF TRUTH — enriched with logged-in user's aliases
  // isMyFFAWin() is NOT used for name resolution to ensure deterministic leaderboard.
  let pid = run.playerId;
  if (!pid) {
    const n2p = nameToPlayerIdOverride || buildNameToPlayerId();
    pid = n2p[run.player];
  }
  if (pid && aliasMap[pid]?.name) return aliasMap[pid].name;
  return run.player;
}

let _nameToPlayerIdCache = null;
function buildNameToPlayerId() {
  if (_nameToPlayerIdCache) return _nameToPlayerIdCache;
  _nameToPlayerIdCache = {};
  for (const [pid, data] of Object.entries(aliasMap)) {
    (data.aliases || []).forEach(alias => { _nameToPlayerIdCache[alias] = pid; });
    if (data.name) _nameToPlayerIdCache[data.name] = pid;
  }
  return _nameToPlayerIdCache;
}

function getMyRuns() {
  if (!currentUser || playerGameIds.size === 0) return [];
  return allRuns.filter((r) => isMyFFAWin(r));
}

/* ── API error banner ── */

function showApiError(msg) {
  const box = document.getElementById("profile-api-error");
  if (!box) return;
  if (msg) {
    box.hidden = false;
    box.textContent = msg;
  } else {
    box.hidden = true;
    box.textContent = "";
  }
}

/* ── Render: Profile card ── */

function renderProfileCard() {
  const av = document.getElementById("profile-avatar-large");
  const title = document.getElementById("profile-title-name");
  const badge = document.getElementById("profile-public-badge");
  if (!currentUser) return;

  if (av) {
    if (currentUser.avatar) {
      av.innerHTML = `<img src="${esc(currentUser.avatar)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      const ini = (currentUser.name || "U").slice(0, 2).toUpperCase();
      av.textContent = ini;
      av.style.background = "linear-gradient(135deg, var(--accent), var(--accentL))";
    }
  }
  if (title) title.textContent = currentUser.name || "—";
  if (badge) badge.textContent = currentUser.publicId || "Pas de Public ID";
}

/* ── Render: Stats row ── */

function renderStatsRow(sessions) {
  // Total wins = toutes les sessions gagnées (tous modes confondus : FFA, équipe, etc.)
  const totalWins = sessions.filter((s) => s.hasWon).length;
  // Maps uniques jouées
  const maps = new Set(sessions.map((s) => s.map).filter(Boolean));

  // Rang sur le leaderboard OpenRuns (FFA uniquement)
  // FIX: Search using ALL known aliases, not just currentUser.name.
  // The leaderboard may use a different canonical name than currentUser.name
  // if the aliasMap maps to a different display name.
  let rank = 0;
  if (currentUser) {
    // Collect all names that could represent this user in the leaderboard
    const searchNames = new Set([currentUser.name, ...playerAliases]);
    // Also check the aliasMap for the canonical name that might appear
    for (const [pid, data] of Object.entries(aliasMap)) {
      if (data.name && (
        data.name === currentUser.name ||
        (data.aliases || []).some(a => a === currentUser.name || playerAliases.has(a))
      )) {
        searchNames.add(data.name);
      }
    }
    for (let i = 0; i < globalLeaderboard.length; i++) {
      if (searchNames.has(globalLeaderboard[i].player)) {
        rank = i + 1;
        break;
      }
    }
  }

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("profile-stat-wins", String(totalWins));
  set("profile-stat-sessions", String(sessions.length));
  set("profile-stat-maps", String(maps.size));
  set("profile-stat-global-rank", rank > 0 ? `#${rank}` : "—");
}

/* ── Render: Monthly wins chart ── */

function buildMonthlyWins(sessions) {
  const months = [];
  const now = new Date();

  // Last 6 months
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    const label = d.toLocaleDateString(undefined, { month: "short" });
    months.push({ key, label, value: 0 });
  }

  // Count WINS per month from API sessions (tous modes confondus)
  sessions.forEach((s) => {
    if (!s.hasWon) return; // Seulement les victoires
    const raw = s.start || s.end;
    if (!raw) return;
    const d = new Date(raw);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    const slot = months.find((m) => m.key === key);
    if (slot) slot.value++;
  });

  return months;
}

function renderMonthlyChart(sessions) {
  const el = document.getElementById("chart-monthly-wins");
  if (!el) return;

  const buckets = buildMonthlyWins(sessions);
  const max = Math.max(1, ...buckets.map((b) => b.value));

  if (!buckets.some(b => b.value > 0)) {
    el.innerHTML = `<div class="pf-empty">Aucune victoire pour le moment</div>`;
    return;
  }

  el.innerHTML = buckets.map((b) => `
    <div class="pf-chart-row">
      <span class="pf-chart-label">${esc(b.label)}</span>
      <div class="pf-chart-track">
        <div class="pf-chart-fill" style="width:${Math.round((b.value / max) * 100)}%"></div>
      </div>
      <span class="pf-chart-val">${b.value}</span>
    </div>
  `).join("");
}

/* ── Render: Last 5 games (from API sessions — ALL game types) ── */

function renderRecentGames(sessions) {
  const box = document.getElementById("profile-recent-games");
  if (!box) return;

  // Trier par date décroissante, prendre les 5 plus récentes
  const recent = [...sessions]
    .sort((a, b) => {
      const ta = new Date(a.start || a.end || 0).getTime();
      const tb = new Date(b.start || b.end || 0).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  if (!recent.length) {
    box.innerHTML = `<div class="pf-empty">Aucune partie trouvée — vérifiez votre Public ID</div>`;
    return;
  }

  box.innerHTML = recent.map((s) => {
    const mapName = esc(s.map || "—");
    const mode = esc(s.mode || s.type || "—");
    const url = s.gameId ? `https://openfront.io/game/${s.gameId}` : "#";
    const won = s.hasWon === true;
    const date = formatDate(s.start || s.end);

    // Calculer la durée si possible
    let duration = "";
    if (s.start && s.end) {
      const dur = Math.round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 1000);
      if (dur > 0) duration = formatDuration(dur);
    }

    return `
      <a class="pf-game" href="${esc(url)}" target="_blank" rel="noopener">
        <div class="pf-game-icon ${won ? "won" : "lost"}">${won ? "W" : "L"}</div>
        <div class="pf-game-body">
          <div class="pf-game-map">${mapName}</div>
          <div class="pf-game-meta">${mode}${duration ? " · " + duration : ""} · ${date}</div>
        </div>
        <div class="pf-game-link">▶</div>
      </a>
    `;
  }).join("");
}

function formatDuration(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/* ── OpenFront API fetch ── */

function applySessionsFromFirestore(data) {
  const sessions = Array.isArray(data?.openFrontSessions) ? data.openFrontSessions : [];
  playerClientIds = new Set(sessions.map((s) => s.clientId).filter(Boolean));
  playerAliases = new Set(sessions.map((s) => s.username).filter(Boolean));
  playerGameIds = new Set(sessions.map((s) => s.gameId || s.game || s.id).filter(Boolean));
  playerSessionMap = new Map();
  sessions.forEach((s) => {
    const gid = s.gameId || s.game || s.id;
    if (gid) playerSessionMap.set(gid, s);
  });
  // Normaliser les sessions Firestore pour qu'elles aient la même structure que les sessions API
  return sessions.map((s) => normalizeSession(s)).filter(Boolean);
}

async function fetchOpenFrontPlayerData(publicId) {
  if (!publicId) return { info: null, sessions: [] };

  let info = null;
  let sessions = [];

  try {
    try {
      info = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    } catch (e) {
      console.warn("[profile] Erreur fetch player info:", e.message);
    }

    try {
      const raw = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}/sessions`);
      sessions = parseSessionsPayload(raw, info);
    } catch (e) {
      console.warn("[profile] Erreur fetch sessions:", e.message);
    }
  } catch (e) {
    console.error("[profile] Erreur globale fetchOpenFrontPlayerData:", e);
  }

  return { info, sessions };
}

/* ── Refresh profile ── */

async function refreshProfile() {
  if (!currentUser?.publicId) return;

  showApiError(null);

  const apiData = await fetchOpenFrontPlayerData(currentUser.publicId);
  apiPlayerInfo = apiData.info;
  apiSessions = apiData.sessions;

  if (apiSessions.length > 0) {
    playerClientIds = new Set(apiSessions.map((s) => s.clientId).filter(Boolean));
    playerAliases = new Set(apiSessions.map((s) => s.username).filter(Boolean));
    playerGameIds = new Set(apiSessions.map((s) => s.gameId || s.game || s.id).filter(Boolean));
    playerSessionMap = new Map();
    apiSessions.forEach((s) => {
      const gid = s.gameId || s.game || s.id;
      if (gid) playerSessionMap.set(gid, s);
    });
  } else {
    const data = firestoreProfile || {};
    applySessionsFromFirestore(data);
  }

  if (apiSessions.length > 0 && currentUser.uid) {
    try {
      const ref = doc(db, "users", currentUser.uid);
      const update = {
        openFrontSessions: apiSessions.map(s => ({
          clientId: s.clientId || null,
          username: s.username || null,
          gameId: s.gameId || null,
          map: s.map || null,
          mode: s.mode || null,
          type: s.type || null,
          hasWon: s.hasWon || false,
          start: s.start || null,
          end: s.end || null,
        })),
        openFrontPlayerInfo: apiPlayerInfo,
        openFrontSyncedAt: new Date().toISOString(),
        openFrontSyncPending: false,
      };
      await setDoc(ref, update, { merge: true });
    } catch (e) {
      console.warn("[profile] Erreur mise à jour Firestore:", e);
    }
  }

  const sessions = apiSessions.length > 0
    ? apiSessions
    : applySessionsFromFirestore(firestoreProfile || {});

  if (!sessions.length) {
    const data = firestoreProfile || {};
    if (data.openFrontSyncPending || !data.openFrontSyncedAt) {
      showApiError("Synchronisation en cours...");
    }
  }

  // Render everything — on utilise les sessions API (tous modes, avec hasWon)
  renderStatsRow(sessions);
  renderMonthlyChart(sessions);
  renderRecentGames(sessions);
}

/* ── Reward code system — SUPPRIMÉ ── */
// La base de données des skins (public-rewards + reward-codes) a été supprimée.
// Les fonctions ci-dessous sont gardées comme stubs pour éviter les erreurs HTML.

window.selectCosmetic = async () => {};
window.toggleReward = async () => {};
window.redeemCode = async () => {};

/* ── Firestore save ── */

async function saveProfileToFirestore(username, publicIdNew) {
  const uid = currentUser.uid;
  const ref = doc(db, "users", uid);
  const existing = firestoreProfile || {};

  if (existing.publicId && publicIdNew && publicIdNew !== existing.publicId) {
    alert("Le Public ID ne peut pas être modifié.");
    return false;
  }

  const payload = {
    username,
    email: currentUser.email || existing.email || "",
    updatedAt: new Date().toISOString(),
  };

  if (!existing.publicId && publicIdNew) {
    payload.publicId = publicIdNew;
    payload.createdAt = new Date().toISOString();
    payload.openFrontSyncPending = true;
  } else if (existing.publicId) {
    payload.publicId = existing.publicId;
  }

  await setDoc(ref, payload, { merge: true });
  firestoreProfile = { ...existing, ...payload };
  currentUser.name = username;
  currentUser.publicId = payload.publicId;
  return true;
}

/* ── Window-exposed handlers ── */

window.saveInitialProfile = async () => {
  const username = document.getElementById("setup-username")?.value.trim();
  const publicId = document.getElementById("setup-public-id")?.value.trim();
  if (!username || !publicId) {
    alert("Remplissez tous les champs.");
    return;
  }
  if (!(await saveProfileToFirestore(username, publicId))) return;
  showProfileView("profile-main");
  renderProfileCard();
  await refreshProfile();
};

window.saveProfileEdits = async () => {
  const username = document.getElementById("edit-username")?.value.trim();
  if (!username) {
    alert("Entrez un nom d'utilisateur.");
    return;
  }
  if (!(await saveProfileToFirestore(username, currentUser.publicId))) return;
  toggleEditPanel();
  renderProfileCard();
  updateAuthUI(currentUser);
  await refreshProfile();
};

window.toggleEditPanel = () => {
  const panel = document.getElementById("profile-edit-panel");
  if (!panel) return;
  const open = panel.style.display !== "none";
  panel.style.display = open ? "none" : "block";
  if (!open && currentUser) {
    document.getElementById("edit-username").value = currentUser.name || "";
    document.getElementById("edit-public-id").value = currentUser.publicId || "";
  }
};

window.toggleAuthModal = () => {
  document.getElementById("auth-modal")?.classList.toggle("active");
};

window.handleLogin = async (provider) => {
  try {
    if (provider === "google") await window.loginWithGoogle();
    else if (provider === "discord") await window.loginWithDiscord();
    toggleAuthModal();
  } catch (e) {
    console.error(e);
  }
};

window.handleLogout = (e) => {
  if (e) e.stopPropagation();
  if (confirm("Se déconnecter ?")) {
    window.logout();
    window.location.href = "index.html";
  }
};

window.toggleUserDropdown = (e) => {
  if (e) e.stopPropagation();
  document.getElementById("user-container")?.classList.toggle("open");
};

function updateAuthUI(user) {
  const login = document.getElementById("login-btn-main");
  const container = document.getElementById("user-container");
  if (user) {
    if (login) login.style.display = "none";
    if (container) container.style.display = "block";
    const nameEl = document.getElementById("user-display-name");
    if (nameEl) nameEl.textContent = user.name || "User";
  } else {
    if (login) login.style.display = "flex";
    if (container) container.style.display = "none";
  }
}

document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ── Auth state ── */

let profileUnsub = null;

onAuthStateChanged(auth, async (user) => {
  if (profileUnsub) {
    profileUnsub();
    profileUnsub = null;
  }
  showProfileView("profile-loading");

  if (!user) {
    currentUser = null;
    firestoreProfile = null;
    updateAuthUI(null);
    showProfileView("profile-gate");
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || !snap.data().publicId) {
      currentUser = { uid: user.uid, avatar: user.photoURL, email: user.email };
      firestoreProfile = snap.exists() ? snap.data() : {};
      const setupUser = document.getElementById("setup-username");
      const setupId = document.getElementById("setup-public-id");
      if (setupUser && firestoreProfile.username) setupUser.value = firestoreProfile.username;
      if (setupId && firestoreProfile.publicId) setupId.value = firestoreProfile.publicId;
      updateAuthUI(currentUser);
      showProfileView("profile-setup");
      return;
    }

    const data = snap.data();
    firestoreProfile = data;
    currentUser = {
      uid: user.uid,
      name: data.username || user.displayName || "Joueur",
      publicId: data.publicId,
      avatar: user.photoURL,
      email: user.email,
    };

    applySessionsFromFirestore(data);

    updateAuthUI(currentUser);
    showProfileView("profile-main");
    renderProfileCard();

    await loadRunsData();
    buildLeaderboard();
    await refreshProfile();

    profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (!snap.exists()) return;
      firestoreProfile = snap.data();
      refreshProfile();
    }, (error) => {
      console.warn("[profile] Firestore user listener error (non-critique):", error.message);
    });
  } catch (e) {
    console.error("[profile]", e);
    showProfileView("profile-main");
  }
});
