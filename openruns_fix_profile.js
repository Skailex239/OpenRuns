import {
  auth, db, doc, getDoc, getDocs, setDoc, updateDoc, arrayUnion, onSnapshot, onAuthStateChanged,
  collection, query, where,
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

// Utilitaire : décompresser un flux gzip et parser le JSON
async function fetchGzipJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  try {
    const ds = new DecompressionStream("gzip");
    const decompressedStream = res.body.pipeThrough(ds);
    return await new Response(decompressedStream).json();
  } catch(e) {
    // Fallback : le fichier n'est peut-être pas compressé
    console.warn("[profile] Décompression gzip échouée, fallback JSON brut:", e.message);
    const fallbackRes = await fetch(url.replace('.gz', ''));
    return await fallbackRes.json();
  }
}

async function loadRunsData() {
  let data;
  try {
    // OPTIMISATION : charger les deux fichiers en gzip (économise ~20MB sur player_aliases)
    const [runsRes, aliasRes] = await Promise.allSettled([
      fetchGzipJson(`runs.json.gz?_=${Date.now()}`),
      fetchGzipJson(`player_aliases.json.gz?_=${Date.now()}`),
    ]);

    // Alias map (optionnel) — maintenant chargé en gzip (321KB au lieu de 20MB)
    if (aliasRes.status === 'fulfilled') {
      aliasMap = aliasRes.value;
      _nameToPlayerIdCache = null;
      console.log(`[profile] ${Object.keys(aliasMap).length} identités joueurs chargées (gzip)`);
    } else {
      // Fallback sur le fichier non compressé si le gz n'existe pas
      try {
        const fallbackAlias = await fetch(`player_aliases.json?_=${Date.now()}`);
        if (fallbackAlias.ok) { aliasMap = await fallbackAlias.json(); _nameToPlayerIdCache = null; }
      } catch(e2) { console.warn("[profile] Impossible de charger les aliases:", e2); }
    }

    if (runsRes.status === 'fulfilled') {
      data = runsRes.value;
    } else {
      // Fallback sur le fichier non compressé
      try {
        const r = await fetch(`runs.json?_=${Date.now()}`);
        if (!r.ok) throw new Error("runs.json HTTP " + r.status);
        data = await r.json();
      } catch(e) {
        console.error("[profile] Fallback runs.json also failed:", e);
        data = { runs: [] };
      }
    }
  } catch(e) {
    console.warn("[profile] loadRunsData fetch error:", e);
    data = { runs: [] };
  }
  // Support de l'ancien format (tableau) et du nouveau (objet {runs, totalCount})
  allRuns = Array.isArray(data) ? data : (data.runs || []);
}

/* ── Leaderboard & matching ── */

function buildLeaderboard() {
  playerStats = {};
  const nameToPlayerId = buildNameToPlayerId();

  allRuns.forEach((run) => {
    const name = getCanonicalPlayerName(run, nameToPlayerId);
    if (!name) return;
    if (!playerStats[name]) {
      playerStats[name] = { wins: 0, maps: new Set(), runs: [], points: 0 };
    }
    const p = playerStats[name];
    p.wins++;
    p.maps.add(run.map);
    // OPTIMISATION : ne pas cloner le run, stocker seulement la référence
    p.runs.push(run);
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
  if (isMyFFAWin(run)) {
    return currentUser.name;
  }
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
  let rank = 0;
  if (currentUser) {
    const myName = currentUser.name;
    for (let i = 0; i < globalLeaderboard.length; i++) {
      if (globalLeaderboard[i].player === myName) {
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

let _lastSyncedSessionsHash = null; // Pour éviter les écritures Firestore inutiles
let _isRefreshFromSnapshot = false; // Flag: refreshProfile appelé par onSnapshot

function simpleSessionsHash(sessions) {
  // Hash rapide basé sur gameId + hasWon pour détecter les vrais changements
  if (!sessions || sessions.length === 0) return '';
  return sessions.map(s => `${s.gameId || s.id || ''}:${s.hasWon ? 1 : 0}`).join('|');
}

async function refreshProfile(opts = {}) {
  if (!currentUser?.publicId) return;

  const fromSnapshot = opts.fromSnapshot || _isRefreshFromSnapshot;

  showApiError(null);

  // Si appelé depuis onSnapshot, on ne fait PAS de fetch API ni d'écriture Firestore
  // On se contente de re-rendre avec les données existantes + les nouvelles données Firestore
  if (fromSnapshot) {
    const sessions = apiSessions.length > 0
      ? apiSessions
      : applySessionsFromFirestore(firestoreProfile || {});

    if (!sessions.length) {
      const data = firestoreProfile || {};
      if (data.openFrontSyncPending || !data.openFrontSyncedAt) {
        showApiError("Synchronisation en cours...");
      }
    }

    renderStatsRow(sessions);
    renderMonthlyChart(sessions);
    renderRecentGames(sessions);
    return;
  }

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

  // Écrire dans Firestore SEULEMENT si les sessions ont changé
  // et qu'on n'est PAS appelé depuis onSnapshot (pour éviter la boucle infinie)
  if (apiSessions.length > 0 && currentUser.uid) {
    const newHash = simpleSessionsHash(apiSessions);
    if (newHash !== _lastSyncedSessionsHash) {
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
        _isRefreshFromSnapshot = true; // Activer le flag AVANT l'écriture
        await setDoc(ref, update, { merge: true });
        _lastSyncedSessionsHash = newHash;
      } catch (e) {
        console.warn("[profile] Erreur mise à jour Firestore:", e.message);
      } finally {
        _isRefreshFromSnapshot = false; // Toujours remettre le flag à false
      }
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

/* ── Reward code system (multi-cosmetic) ── */

let ownedTypes = [];       // Tous les cosmétiques possédés: ["vip", "flame", "rainbow"]
let activeType = null;     // Le cosmétique actuellement sélectionné (ou null)
let rewardActivated = true; // Toggle global on/off

/* ── Local test codes (bypass Firestore for testing) ── */
const LOCAL_TEST_CODES = {
  "OR-VIP01":    { type: "vip" },
  "OR-FLAM1":    { type: "flame" },
  "OR-RNBW1":    { type: "rainbow" },
  "OR-CYBR1":    { type: "cyberpunk" },
  "OR-SNST1":    { type: "sunset" },
  "OR-AURO1":    { type: "aurore" },
  "OR-PSTL1":    { type: "pastel" },
  "OR-GOLD1":    { type: "gold" },
  "OR-VLKN1":    { type: "volcano" },
  "OR-OCEA1":    { type: "ocean" },
  "OR-MIAM1":    { type: "miami" },
  "OR-TOXC1":    { type: "toxic" },
  "OR-CHRM1":    { type: "chroma" },
};

function getUsedLocalCodes() {
  try {
    return JSON.parse(localStorage.getItem('openruns_used_local_codes') || '[]');
  } catch { return []; }
}
function markLocalCodeUsed(code) {
  const used = getUsedLocalCodes();
  if (!used.includes(code)) used.push(code);
  localStorage.setItem('openruns_used_local_codes', JSON.stringify(used));
}

/**
 * Synchronise l'état localStorage des codes locaux avec ownedTypes réel.
 * Si un code est marqué "utilisé" dans localStorage mais le type n'est PAS dans ownedTypes,
 * on le démarque (le code redevient disponible).
 * Ceci empêche le bug où un code est marqué utilisé mais le cosmétique n'a pas été sauvé.
 */
function syncLocalCodeState() {
  const usedCodes = getUsedLocalCodes();
  const fixedCodes = usedCodes.filter(code => {
    const localCode = LOCAL_TEST_CODES[code];
    if (!localCode) return false; // Code inconnu, on le retire
    // Si le type est dans ownedTypes, le code est légitimement utilisé
    if (ownedTypes.includes(localCode.type)) return true;
    // Sinon, le code a été marqué utilisé par erreur → on le libère
    console.log(`[profile] Libération du code local ${code} (type ${localCode.type} non possédé)`);
    return false;
  });
  if (fixedCodes.length !== usedCodes.length) {
    localStorage.setItem('openruns_used_local_codes', JSON.stringify(fixedCodes));
    console.log(`[profile] syncLocalCodeState: ${usedCodes.length - fixedCodes.length} code(s) libéré(s)`);
  }
}

/**
 * Sauvegarde ownedTypes dans localStorage comme backup en cas d'échec Firestore.
 * Clé: openruns_owned_types_{uid}
 */
function saveOwnedTypesLocal() {
  if (!currentUser) return;
  try {
    localStorage.setItem(`openruns_owned_types_${currentUser.uid}`, JSON.stringify({
      ownedTypes,
      activeType,
      rewardActivated,
      savedAt: new Date().toISOString(),
    }));
  } catch (e) { /* ignore */ }
}

/**
 * Charge ownedTypes depuis localStorage si Firestore a échoué (fallback).
 * Ne remplace PAS les données Firestore si elles sont valides.
 */
function loadOwnedTypesLocal() {
  if (!currentUser) return false;
  try {
    const raw = localStorage.getItem(`openruns_owned_types_${currentUser.uid}`);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Array.isArray(data.ownedTypes) && data.ownedTypes.length > 0) {
      // Fusionner avec les données Firestore (qui peuvent être vides)
      data.ownedTypes.forEach(t => {
        if (!ownedTypes.includes(t)) ownedTypes.push(t);
      });
      if (!activeType && data.activeType) activeType = data.activeType;
      console.log(`[profile] Restauration locale: ${data.ownedTypes.length} cosmétique(s)`);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// Reset local test codes (for debugging) — accessible depuis la console
window.resetLocalTestCodes = () => {
  localStorage.removeItem('openruns_used_local_codes');
  console.log('[profile] Codes de test locaux réinitialisés !');
};

const REWARD_LABELS = {
  vip:       { name: "VIP",           desc: "Pseudo rouge vif animé" },
  flame:     { name: "FLAME",         desc: "Pseudo orange / jaune / rouge animé" },
  rainbow:   { name: "RAINBOW",       desc: "Pseudo arc-en-ciel avec vague animée" },
  cyberpunk: { name: "CYBERPUNK",     desc: "Néon cyberpunk animé" },
  sunset:    { name: "SUNSET",        desc: "Coucher de soleil animé" },
  aurore:    { name: "AURORE",        desc: "Aurore boréale animée" },
  pastel:    { name: "PASTEL",        desc: "Dégradé pastel animé" },
  gold:      { name: "GOLDEN",        desc: "Heure dorée animée" },
  volcano:   { name: "VOLCANO",       desc: "Volcan rouge animé" },
  ocean:     { name: "OCEAN",         desc: "Océan profond animé" },
  miami:     { name: "MIAMI",         desc: "Miami Vice animé" },
  toxic:     { name: "TOXIC",         desc: "Acide toxique animé" },
  chroma:    { name: "CHROMA",        desc: "RGB pur animé" },
};

/**
 * Charge les récompenses du joueur depuis la collection public-rewards
 */
async function loadUserReward() {
  if (!currentUser) return;
  let firestoreLoaded = false;
  try {
    const snap = await getDoc(doc(db, "public-rewards", currentUser.uid));
    if (snap.exists()) {
      const data = snap.data();
      // Migration: ancien format {type, activated} → nouveau format {ownedTypes, activeType, activated}
      if (data.ownedTypes && Array.isArray(data.ownedTypes)) {
        ownedTypes = data.ownedTypes;
        activeType = data.activeType || null;
        rewardActivated = data.activated !== false;
        firestoreLoaded = true;
      } else if (data.type) {
        // Ancien format → migration automatique
        ownedTypes = [data.type];
        activeType = data.type;
        rewardActivated = data.activated !== false;
        firestoreLoaded = true;
        // Migrer vers le nouveau format dans Firestore
        try {
          await setDoc(doc(db, "public-rewards", currentUser.uid), {
            ownedTypes: ownedTypes,
            activeType: activeType,
            activated: rewardActivated,
          }, { merge: true });
        } catch (migrateErr) {
          console.warn("[profile] Erreur migration récompense:", migrateErr.message);
        }
      } else {
        ownedTypes = [];
        activeType = null;
        rewardActivated = true;
      }
    } else {
      ownedTypes = [];
      activeType = null;
      rewardActivated = true;
    }
  } catch (e) {
    console.warn("[profile] Erreur chargement récompense:", e.message);
    ownedTypes = [];
    activeType = null;
    rewardActivated = true;
  }

  // TOUJOURS fusionner avec le backup local pour récupérer les types
  // que Firestore n'a pas (ex: write Firestore a échoué à cause du rate limiting)
  // loadOwnedTypesLocal() ne remplace pas les données existantes, il ajoute seulement les manquants
  loadOwnedTypesLocal();

  // Si Firestore avait des données mais le backup en a plus, resynchroniser Firestore
  if (firestoreLoaded && currentUser) {
    const localBackup = (() => {
      try {
        const raw = localStorage.getItem(`openruns_owned_types_${currentUser.uid}`);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    })();
    if (localBackup && Array.isArray(localBackup.ownedTypes) && localBackup.ownedTypes.length > ownedTypes.length) {
      // Le backup local a plus de données que Firestore → on met à jour Firestore
      console.log(`[profile] Resynchronisation Firestore: ${ownedTypes.length} → ${localBackup.ownedTypes.length} cosmétique(s)`);
      try {
        await setDoc(doc(db, "public-rewards", currentUser.uid), {
          ownedTypes: localBackup.ownedTypes,
          activeType: localBackup.activeType || activeType,
          activated: localBackup.rewardActivated !== false,
        }, { merge: true });
      } catch (syncErr) {
        console.warn("[profile] Erreur resynchronisation Firestore:", syncErr.message);
      }
    }
  }

  // Synchroniser les codes locaux avec l'état réel des cosmétiques possédés
  syncLocalCodeState();

  // Sauvegarder le backup local à jour
  saveOwnedTypesLocal();

  renderRewardSection();
  applyProfileVipStyle();
}

/**
 * Affiche l'état des récompenses dans le profil
 */
function renderRewardSection() {
  const activeSection = document.getElementById("pf-reward-active");
  const form = document.getElementById("pf-reward-form");
  const cosmeticsGrid = document.getElementById("pf-cosmetics-grid");
  const toggleSwitch = document.getElementById("pf-reward-toggle-switch");
  const toggleLabel = document.getElementById("pf-toggle-label");

  if (ownedTypes.length > 0) {
    if (activeSection) activeSection.style.display = "block";
    if (form) form.style.display = "block"; // Toujours afficher le form pour ajouter d'autres codes

    // Afficher la grille de cosmétiques possédés (casier)
    if (cosmeticsGrid) {
      cosmeticsGrid.innerHTML = ownedTypes.map(type => {
        const info = REWARD_LABELS[type] || { name: type.toUpperCase(), desc: "Cosmétique spécial" };
        const isSelected = type === activeType;
        return `
          <div class="pf-cosmetic-card ${isSelected ? 'selected' : ''} ${type}" onclick="selectCosmetic('${type}')">
            <span class="pf-cosmetic-name player-${type}">${info.name}</span>
            <span class="pf-cosmetic-desc">${info.desc}</span>
            ${isSelected ? '<span class="pf-cosmetic-check">✓ Actif</span>' : '<span class="pf-cosmetic-equip">Cliquez pour équiper</span>'}
          </div>
        `;
      }).join("");
    }

    // Mettre à jour le compteur du casier
    const lockerCount = document.getElementById("pf-locker-count");
    if (lockerCount) {
      lockerCount.textContent = `${ownedTypes.length} cosmétique${ownedTypes.length > 1 ? 's' : ''}`;
    }

    // Mettre à jour le toggle global
    if (toggleSwitch) {
      toggleSwitch.classList.toggle("on", rewardActivated);
      toggleSwitch.classList.remove("is-vip", "is-flame", "is-rainbow", "is-cyberpunk", "is-sunset", "is-aurore", "is-pastel", "is-gold", "is-volcano", "is-ocean", "is-miami", "is-toxic", "is-chroma");
      if (activeType) toggleSwitch.classList.add(`is-${activeType}`);
    }
    if (toggleLabel) {
      toggleLabel.textContent = rewardActivated ? "Activé" : "Désactivé";
      toggleLabel.classList.toggle("off", !rewardActivated);
    }
  } else {
    if (activeSection) activeSection.style.display = "none";
    if (form) form.style.display = "block";
  }

  // Afficher les codes de test disponibles
  const testCodesHint = document.getElementById("pf-test-codes-hint");
  const testCodesList = document.getElementById("pf-test-codes-list");
  if (testCodesHint && testCodesList) {
    const availableCodes = Object.entries(LOCAL_TEST_CODES)
      .filter(([code, info]) => !ownedTypes.includes(info.type))
      .map(([code, info]) => `<code style="background:var(--bg2);padding:1px 5px;border-radius:3px;margin-right:6px;cursor:pointer" onclick="document.getElementById('reward-code-input').value='${code}'">${code}</code> <span style="color:var(--text2)">${REWARD_LABELS[info.type]?.name || info.type}</span>`)
      .join('<br>');
    if (availableCodes) {
      testCodesList.innerHTML = availableCodes;
      testCodesHint.style.display = "block";
    } else {
      testCodesHint.style.display = "none";
    }
  }
}

/**
 * Sélectionne un cosmétique parmi ceux possédés
 */
window.selectCosmetic = async (type) => {
  if (!currentUser || !ownedTypes.includes(type)) return;

  // Si on clique sur celui déjà actif, on le désélectionne (activeType = null)
  const newActiveType = (type === activeType) ? null : type;

  try {
    await updateDoc(doc(db, "public-rewards", currentUser.uid), {
      activeType: newActiveType,
      activated: newActiveType ? true : rewardActivated,
    });

    activeType = newActiveType;
    if (newActiveType) rewardActivated = true;
    saveOwnedTypesLocal();
    renderRewardSection();
    applyProfileVipStyle();
  } catch (e) {
    console.error("[profile] Erreur sélection cosmétique:", e);
  }
};

/**
 * Active ou désactive le cosmétique (toggle global)
 */
window.toggleReward = async () => {
  if (!currentUser || ownedTypes.length === 0) return;

  const newState = !rewardActivated;

  try {
    await updateDoc(doc(db, "public-rewards", currentUser.uid), {
      activated: newState,
    });

    rewardActivated = newState;
    saveOwnedTypesLocal();
    renderRewardSection();
    applyProfileVipStyle();
  } catch (e) {
    console.error("[profile] Erreur toggle récompense:", e);
  }
};

/**
 * Applique ou retire le style cosmétique sur le nom du profil
 */
function applyProfileVipStyle() {
  const nameEl = document.getElementById("profile-title-name");
  if (!nameEl) return;

  // Retirer tous les styles cosmétiques
  nameEl.classList.remove("player-vip", "player-flame", "player-rainbow", "player-cyberpunk", "player-sunset", "player-aurore", "player-pastel", "player-gold", "player-volcano", "player-ocean", "player-miami", "player-toxic", "player-chroma");

  // Appliquer le style du cosmétique actif si activé
  if (activeType && rewardActivated) {
    nameEl.classList.add(`player-${activeType}`);
  }
}

window.redeemCode = async () => {
  const input = document.getElementById("reward-code-input");
  const msgEl = document.getElementById("reward-code-msg");
  if (!input || !currentUser) return;

  const code = input.value.trim().toUpperCase();
  if (!code) {
    if (msgEl) { msgEl.textContent = "Entrez un code."; msgEl.className = "pf-reward-msg error"; }
    return;
  }

  if (msgEl) { msgEl.textContent = "Vérification..."; msgEl.className = "pf-reward-msg"; }

  // ── ÉTAPE 1 : Vérifier les codes de test locaux ──
  const localCode = LOCAL_TEST_CODES[code];
  if (localCode) {
    console.log(`[profile] Code local détecté: ${code} → type=${localCode.type}`);

    // PRINCIPAL CHECK: le joueur possède-t-il déjà ce type de cosmétique ?
    // C'est la SEULE vérification qui compte — on ne bloque plus sur localStorage "used"
    // car localStorage peut être désynchronisé avec Firestore
    if (ownedTypes.includes(localCode.type)) {
      console.log(`[profile] Type ${localCode.type} déjà possédé`);
      if (msgEl) { msgEl.textContent = "Vous possédez déjà ce cosmétique !"; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    let firestoreSaveOk = false;

    // Mettre à jour Firestore public-rewards pour le leaderboard
    try {
      const rewardRef = doc(db, "public-rewards", currentUser.uid);
      const rewardSnap = await getDoc(rewardRef);
      const existingData = rewardSnap.exists() ? rewardSnap.data() : {};
      const existingOwnedTypes = Array.isArray(existingData.ownedTypes) ? [...existingData.ownedTypes] : [];
      
      // FUSIONNER les types Firestore + les types en mémoire (qui peuvent avoir été
      // ajoutés localement lors d'un précédent échec Firestore)
      const allTypesSet = new Set([...existingOwnedTypes, ...ownedTypes]);
      if (!allTypesSet.has(localCode.type)) {
        allTypesSet.add(localCode.type);
      }
      const mergedOwnedTypes = [...allTypesSet];

      await setDoc(rewardRef, {
        username: currentUser.name,
        ownedTypes: mergedOwnedTypes,
        activeType: localCode.type,
        activated: true,
        activatedAt: new Date().toISOString(),
      }, { merge: true });

      // Mettre à jour le profil utilisateur (non critique si ça échoue)
      try {
        await updateDoc(doc(db, "users", currentUser.uid), {
          reward: localCode.type,
        });
      } catch (e2) {
        console.warn("[profile] Erreur updateDoc users (non critique):", e2.message);
      }

      ownedTypes = mergedOwnedTypes;
      firestoreSaveOk = true;
    } catch (e) {
      console.warn("[profile] Erreur Firestore pour code local, fallback local:", e.message);
      // Même si Firestore échoue, on applique localement
      if (!ownedTypes.includes(localCode.type)) {
        ownedTypes = [...ownedTypes, localCode.type];
      }
    }

    // Marquer le code comme utilisé APRES traitement (pas avant)
    markLocalCodeUsed(code);

    activeType = localCode.type;
    rewardActivated = true;
    saveOwnedTypesLocal(); // Backup local en cas de problème Firestore
    renderRewardSection();
    applyProfileVipStyle();

    console.log(`[profile] Code local ${code} activé ! ownedTypes=`, ownedTypes, 'activeType=', activeType, 'firestoreSave=', firestoreSaveOk);
    if (msgEl) {
      if (firestoreSaveOk) {
        msgEl.textContent = `Cosmétique ${REWARD_LABELS[localCode.type]?.name || localCode.type} débloqué !`;
      } else {
        msgEl.textContent = `Cosmétique ${REWARD_LABELS[localCode.type]?.name || localCode.type} débloqué (sauvegarde serveur en attente...)`;
      }
      msgEl.className = "pf-reward-msg success";
    }
    input.value = "";
    return;
  }

  // ── ÉTAPE 2 : Vérifier les codes Firestore ──
  try {
    // Chercher le code dans la collection reward-codes
    // On ne filtre que par code (pas par used) pour éviter les problèmes d'index composite Firestore
    const q = query(collection(db, "reward-codes"), where("code", "==", code));
    const snap = await getDocs(q);

    console.log(`[profile] Firestore query pour "${code}": ${snap.size} document(s) trouvé(s)`);

    if (snap.empty) {
      if (msgEl) { msgEl.textContent = "Code invalide."; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    // Debug: afficher l'état de chaque document trouvé
    snap.docs.forEach((d, i) => {
      const data = d.data();
      console.log(`[profile] Doc #${i}: id=${d.id}, used=${data.used} (${typeof data.used}), type=${data.type}, code=${data.code}`);
    });

    // Trouver un document non utilisé parmi les résultats
    const codeDoc = snap.docs.find(d => {
      const usedVal = d.data().used;
      // Accepter explicitement false, undefined, null, 0 comme "non utilisé"
      // Seul true (booléen) ou "true" (string) est considéré comme utilisé
      return usedVal !== true && usedVal !== "true";
    });

    if (!codeDoc) {
      console.warn(`[profile] Tous les documents pour le code "${code}" sont marqués comme utilisés`);
      if (msgEl) { msgEl.textContent = "Code déjà utilisé."; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    const codeData = codeDoc.data();
    const rewardType = codeData.type || "vip";

    // Vérifier si le joueur possède déjà ce cosmétique
    if (ownedTypes.includes(rewardType)) {
      if (msgEl) { msgEl.textContent = "Vous possédez déjà ce cosmétique !"; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    // Marquer le code comme utilisé
    await setDoc(doc(db, "reward-codes", codeDoc.id), {
      ...codeData,
      used: true,
      usedBy: currentUser.uid,
      usedAt: new Date().toISOString(),
    }, { merge: true });

    // Ajouter le cosmétique au "casier" — lecture puis fusion manuelle
    // On lit d'abord l'état actuel dans Firestore, on fusionne avec la mémoire,
    // puis on sauvegarde avec setDoc merge pour éviter tout écrasement
    const rewardRef = doc(db, "public-rewards", currentUser.uid);
    const rewardSnap = await getDoc(rewardRef);
    const existingData = rewardSnap.exists() ? rewardSnap.data() : {};
    const existingOwnedTypes = Array.isArray(existingData.ownedTypes) ? [...existingData.ownedTypes] : [];
    
    // FUSIONNER les types Firestore + les types en mémoire (qui peuvent avoir été
    // ajoutés localement lors d'un précédent échec Firestore)
    const allTypesSet = new Set([...existingOwnedTypes, ...ownedTypes]);
    if (!allTypesSet.has(rewardType)) {
      allTypesSet.add(rewardType);
    }
    const mergedOwnedTypes = [...allTypesSet];
    
    // Sauvegarder avec setDoc merge pour tout préserver
    await setDoc(rewardRef, {
      username: currentUser.name,
      ownedTypes: mergedOwnedTypes,
      activeType: rewardType, // Le nouveau cosmétique devient actif
      activated: true,
      activatedAt: new Date().toISOString(),
    }, { merge: true });

    // Mettre à jour le profil utilisateur avec le reward actif
    await updateDoc(doc(db, "users", currentUser.uid), {
      reward: rewardType,
    });

    ownedTypes = mergedOwnedTypes; // Utiliser la liste complète fusionnée
    activeType = rewardType;
    rewardActivated = true;
    saveOwnedTypesLocal(); // Backup local
    renderRewardSection();
    applyProfileVipStyle();

    console.log(`[profile] Code Firestore ${code} activé ! ownedTypes=`, ownedTypes, 'activeType=', activeType);
    if (msgEl) { msgEl.textContent = `Cosmétique ${REWARD_LABELS[rewardType]?.name || rewardType} débloqué !`; msgEl.className = "pf-reward-msg success"; }
    input.value = "";
  } catch (e) {
    console.error("[profile] Erreur redemption code:", e);
    if (msgEl) { msgEl.textContent = "Erreur lors de l'activation. Réessayez."; msgEl.className = "pf-reward-msg error"; }
  }
};

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

// Afficher les codes de test dans la console au chargement
console.log('[profile] Codes de test disponibles:', Object.keys(LOCAL_TEST_CODES).join(', '));
console.log('[profile] Pour réinitialiser les codes locaux: resetLocalTestCodes()');

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
    await loadUserReward();

    profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (!snap.exists()) return;
      firestoreProfile = snap.data();
      // IMPORTANT: Ne PAS appeler refreshProfile() directement ici !
      // Cela créerait une boucle infinie (refreshProfile écrit dans Firestore → onSnapshot → refreshProfile → ...)
      // On met à jour les sessions locales et on re-render uniquement
      const sessions = apiSessions.length > 0
        ? apiSessions
        : applySessionsFromFirestore(firestoreProfile);
      renderStatsRow(sessions);
      renderMonthlyChart(sessions);
      renderRecentGames(sessions);
    }, (error) => {
      console.warn("[profile] Firestore user listener error (non-critique):", error.message);
    });
  } catch (e) {
    console.error("[profile]", e);
    showProfileView("profile-main");
  }
});
