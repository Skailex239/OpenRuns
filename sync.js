// Charger .env manuellement AVANT les imports
import fs from "fs";
try {
  const envContent = fs.readFileSync(".env", "utf8");
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim();
    if (key && value) {
      process.env[key.trim()] = value;
    }
  });
} catch (e) {
  // .env optionnel
}

import fetch from "node-fetch";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  warnIfNoExemption,
  hasExemption,
  resetApiStats,
  logApiStats,
} from "./openfront-api.js";

// ── Configuration ─────────────────────────────────────────────────────────────
const FETCH_TIMEOUT    = 8_000;
const TIME_OFFSET_SECS = 32;

const HAS_EXEMPTION = hasExemption();

// Avertir si pas d'exemption (après chargement du .env)
if (!HAS_EXEMPTION) {
  console.warn("[openfront-api] OPENFRONT_SKAILEX_ACCESS absent — requêtes sans exemption (rate limit strict)");
} else {
  console.log("[sync] 🔑 Exemption Skailex active");
}
// Fenêtres de 30s : évite de rater des parties si l'API tronque une grosse plage
const WINDOW_MS  = 30 * 1_000;
const HISTORY_MS = 400 * 24 * 60 * 60 * 1_000;
const TARGET_DATE = new Date("2025-11-01").getTime();

const BATCH_DELAY_NORMAL  = HAS_EXEMPTION ? 0 : 200;
const WINDOW_DELAY        = HAS_EXEMPTION ? 0 : 50;
const DETAIL_CONCURRENCY  = HAS_EXEMPTION ? 12 : 2;
const DELAY_429           = HAS_EXEMPTION ? 2_000 : 8_000;
const CHECKPOINT_EVERY    = 20;
const DEFAULT_HISTORY_WINDOWS = HAS_EXEMPTION ? 500 : 40;

function resolveHistoryWindowLimit(argv) {
  const env = parseInt(process.env.SYNC_HISTORY_WINDOWS || "", 10);
  if (!Number.isNaN(env) && env > 0) return env;
  const arg = parseInt(argv[1] || "", 10);
  if (!Number.isNaN(arg) && arg > 0) return arg;
  return DEFAULT_HISTORY_WINDOWS;
}

const RECENT_MAX_MS = 3 * 60 * 60 * 1_000;
const RECENT_OVERLAP_MS = 10 * 60 * 1_000;
const GAMES_LIST_FILTER = "type=Public&mode=Free%20For%20All";

const WINDOW_SATURATION_THRESHOLD = 45;

const RUNS_FILE        = "runs.json";
const RUNS_BACKUP_FILE = "runs_backup.json";
const RUNS_FULL_FILE   = "runs_full.json";
const CHECKPOINT_FILE = "checkpoint.json";
const SEEN_FILE       = "seen.json";

let currentLatestCommit = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Persistence ───────────────────────────────────────────────────────────────
function loadRuns() {
  try {
    if (fs.existsSync(RUNS_FULL_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RUNS_FULL_FILE, "utf8"));
      return Array.isArray(raw) ? raw : (raw.runs || []);
    }
    const raw = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : (raw.runs || []);
  } catch { return []; }
}

function saveRuns(runs) {
  const meta = {
    totalCount: runs.length,
    lastUpdate: new Date().toISOString(),
    latestCommit: currentLatestCommit,
  };

  // Fichier public (sans URL, plus léger)
  const cleanedRuns = runs.map(({ url, ...rest }) => rest);
  const publicOutput = { ...meta, runs: cleanedRuns };
  const jsonString = JSON.stringify(publicOutput);

  fs.writeFileSync(RUNS_FILE, jsonString);
  const gzipped = zlib.gzipSync(jsonString);
  fs.writeFileSync(RUNS_FILE + ".gz", gzipped);

  // Backup complet (toutes les runs + URLs), mis à jour à chaque sync
  const backupOutput = { ...meta, runs };
  const backupString = JSON.stringify(backupOutput);
  fs.writeFileSync(RUNS_BACKUP_FILE, backupString);
  try {
    fs.writeFileSync(RUNS_BACKUP_FILE + ".gz", zlib.gzipSync(backupString));
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible d'écrire runs_backup.json.gz:", e.message);
  }

  // Archive interne (tableau brut, utilisé par loadRuns)
  try {
    fs.writeFileSync(RUNS_FULL_FILE, JSON.stringify(runs));
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible d'écrire runs_full.json:", e.message);
  }

  console.log(
    `[sync] 💾 ${runs.length} runs — public ${(jsonString.length / 1024 / 1024).toFixed(2)} Mo, ` +
    `backup ${(backupString.length / 1024 / 1024).toFixed(2)} Mo`
  );
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); }
  catch { return new Set(); }
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}
function loadCheckpoints() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")); }
  catch { return {}; }
}
function saveCheckpoints(cp) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// ── Fetch avec retry et gestion 429 ──────────────────────────────────────────
async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await openFrontFetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = DELAY_429 * (attempt + 1);
        console.log(`[rate-limit] 429 — attente ${wait}ms (tentative ${attempt + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        if (attempt < retries) { await sleep(500); continue; }
        throw new Error("Timeout");
      }
      if (attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

// ── Normalisation des noms de maps ───────────────────────────────────────────
// On garde les noms EN pour cohérence avec l'API
const MAP_ALIASES = {
  "Afrique":           "Africa",
  "Alpes":             "Alps",
  "Arctique":          "Arctic",
  "Asie":              "Asia",
  "Australie":         "Australia",
  "Amérique du Nord":  "North America",
  "Amérique du Sud":  "South America",
  "Europe":            "Europe",
  "Islande":           "Iceland",
  "Japon":             "Japan",
  "Italie":            "Italy",
  "Italia":            "Italy",
  "Delta du Nil":      "Nile Delta",
  "Fleuve Amazone":    "Amazon River",
  "Mer Noire":         "Black Sea",
  "Détroit du Bosphore":"Bosphorus Straits",
  "Détroit de Béring": "Bering Strait",
  "Mer de Béring":     "Bering Sea",
  "Détroit de Gibraltar":"Strait of Gibraltar",
  "Détroit d'Hormuz":  "Strait of Hormuz",
  "Entre Deux Mers":   "Between Two Seas",
  "Monde":             "World",
  "Pangée":            "Pangaea",
  "Achiran":           "Achiran",
  "Aegean":            "Aegean",
  "Amazon River":      "Amazon River",
  "Antarctica":        "Antarctica",
  "Archipelago Sea":   "Archipelago Sea",
  "ArchipelagoSea":    "Archipelago Sea",
  "Arctic":            "Arctic",
  "Asia":              "Asia",
  "Australia":         "Australia",
  "Baikal":            "Baikal",
  "Baikal (Nuke Wars)": "Baikal (Nuke Wars)",
  "Baja California":   "Baja California",
  "Bering Sea":        "Bering Sea",
  "BeringStrait":      "Bering Strait",
  "BetweenTwoSeas":    "Between Two Seas",
  "BlackSea":          "Black Sea",
  "Bosphorus Straits": "Bosphorus Straits",
  "Britannia":         "Britannia",
  "Britannia Classic": "Britannia Classic",
  "Caucasus":          "Caucasus",
  "Conakry":           "Conakry",
  "Danish Straits":    "Danish Straits",
  "Deglaciated Antarctica": "Deglaciated Antarctica",
  "Didier":            "Didier",
  "Didier (France)":   "Didier (France)",
  "Dyslexdria":        "Dyslexdria",
  "East Asia":         "East Asia",
  "Europe":            "Europe",
  "Falkland Islands":  "Falkland Islands",
  "Faroe Islands":     "Faroe Islands",
  "Four Islands":      "Four Islands",
  "GatewayToTheAtlantic": "Gateway to the Atlantic",
  "Giant_World_Map":   "Giant World Map",
  "Great Lakes":       "Great Lakes",
  "Gulf of St. Lawrence": "Gulf of St. Lawrence",
  "Halkidiki":         "Halkidiki",
  "Hawaii":            "Hawaii",
  "Iceland":           "Iceland",
  "Italia":            "Italia",
  "Japan":             "Japan",
  "Lemnos":            "Lemnos",
  "Lisbon":            "Lisbon",
  "Los Angeles":       "Los Angeles",
  "Luna":              "Luna",
  "Manicouagan":       "Manicouagan",
  "Mare Nostrum":      "Mare Nostrum",
  "Mars":              "Mars",
  "MENA":              "MENA",
  "Middle East":       "Middle East",
  "Milkyway":          "Milkyway",
  "Montreal":          "Montreal",
  "New York City":     "New York City",
  "Nile Delta":        "Nile Delta",
  "NorthAmerica":      "North America",
  "Northwest Passage": "Northwest Passage",
  "Oceania":           "Oceania",
  "Pangaea":           "Pangaea",
  "Passage":           "Passage",
  "Pluto":             "Pluto",
  "SanFrancisco":      "San Francisco",
  "Sierpinski":        "Sierpinski",
  "Americas":          "Americas",
  "Strait of Gibraltar": "Strait of Gibraltar",
  "Strait of Hormuz":  "Strait of Hormuz",
  "Strait Of Malacca": "Strait of Malacca",
  "Surrounded":        "Surrounded",
  "Svalmel":           "Svalmel",
  "Taiwan Strait":     "Taiwan Strait",
  "TheBox":            "The Box",
  "Tourney1":          "Tourney 1",
  "Tourney2":          "Tourney 2",
  "Tourney3":          "Tourney 3",
  "Tourney4":          "Tourney 4",
  "Traders Dream":     "Traders Dream",
  "Two Lakes":         "Two Lakes",
  "Venice":            "Venice",
  "World":             "World",
  "Yenisei":           "Yenisei"
};
function normalizeMap(n) { return MAP_ALIASES[n] || n; }

// ── Extraction d'un speedrun valide ──────────────────────────────────────────
function extractSpeedrun(raw) {
  const detail = raw.info;
  if (!detail) return null;
  const config = detail.config || {};

  // ── Critères de validité ─────────────────────────────────────────────────
  if (config.gameType    !== "Public")       return null;
  if (config.gameMode    !== "Free For All") return null;
  if (config.gameMapSize !== "Normal")       return null;
  if (config.bots        !== 400)            return null;

  const mods = config.publicGameModifiers || {};
  if (mods.isCompact || mods.isRandomSpawn || mods.isCrowded || mods.isHardNations || mods.isAlliancesDisabled) return null;

  if (config.randomSpawn  !== false) return null;
  if (config.donateGold   !== false) return null;
  if (config.donateTroops !== false) return null;
  if (config.infiniteGold)           return null;
  if (config.infiniteTroops)         return null;
  if (config.instantBuild)           return null;
  if (config.startingGold  != null && config.startingGold  !== 0) return null;
  if (config.goldMultiplier != null && config.goldMultiplier !== 1) return null;

  const players = detail.players || [];
  const humanPlayers = players.filter(p => !p.isBot);
  if (humanPlayers.length < 10) return null;

  const winner = detail.winner;
  if (!winner || !Array.isArray(winner) || winner.length < 2) return null;

  const winnerPlayer = players.find(p => p.clientID === winner[1]);
  if (!winnerPlayer?.username || winnerPlayer.isBot) return null;

  // Calcul de la durée
  let durationSecs = null;
  if (detail.duration) {
    const d = detail.duration;
    durationSecs = d > 100_000 ? Math.round(d / 1000) : d;
  } else if (detail.start && detail.end) {
    const diff = detail.end - detail.start;
    durationSecs = diff > 100_000 ? Math.round(diff / 1000) : diff;
  }
  if (!durationSecs || durationSecs < 60) return null;
  durationSecs = Math.max(0, durationSecs - TIME_OFFSET_SECS);

  const gameId = detail.gameID || detail.gameId || detail.id;
  const mapName = normalizeMap(config.gameMap || "Unknown");

  return {
    id:         gameId,
    player:     winnerPlayer.username,
    playerId:   winnerPlayer.clientID,
    map:        mapName,
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots:       400,
    players:    humanPlayers.length,
    timestamp:  detail.start
      ? new Date(detail.start > 1e10 ? detail.start : detail.start * 1000).toISOString()
      : new Date().toISOString(),
    url:        `https://openfront.io/game/${gameId}`,
  };
}

function filterSpeedrunCandidates(games) {
  return games.filter(g =>
    g.type === "Public" &&
    (g.mode === "Free For All" || g.mode === "FFA") &&
    (g.numPlayers == null || g.numPlayers >= 10)
  );
}

/** Découpe [rangeStart, rangeEnd] en intervalles de 30 secondes */
function buildWindows30s(rangeStart, rangeEnd) {
  const windows = [];
  for (let end = rangeEnd.getTime(); end > rangeStart.getTime(); end -= WINDOW_MS) {
    const start = Math.max(end - WINDOW_MS, rangeStart.getTime());
    windows.push({ start: new Date(start), end: new Date(end) });
  }
  return windows;
}

// ── Récupération des parties dans une fenêtre de 30s ──────────────────────────
async function fetchGamesInWindow(start, end) {
  const url =
    `${API_BASE}/public/games?start=${start.toISOString()}&end=${end.toISOString()}` +
    `&${GAMES_LIST_FILTER}`;
  try {
    const data = await fetchWithRetry(url);
    if (!data) return [];
    const games = Array.isArray(data) ? data : (data.games || []);
    return filterSpeedrunCandidates(games);
  } catch (e) {
    if (e.message !== "Timeout") console.warn(`[fetch] ⚠️ ${url}: ${e.message}`);
    return [];
  }
}

async function processOneGame(game, seen, runs, runIds) {
  const gameId = game.game;
  try {
    const raw = await fetchGameDetail(gameId);
    seen.add(gameId);
    const run = extractSpeedrun(raw);
    if (run && !runIds.has(run.id)) {
      runs.push(run);
      runIds.add(run.id);
      const mins = Math.floor(run.duration_s / 60);
      const secs = String(run.duration_s % 60).padStart(2, "0");
      console.log(`[sync] ✅ ${run.player} — ${run.map} — ${mins}m${secs}s (${run.difficulty}, ${run.players}p)`);
      return 1;
    }
  } catch (e) {
    return { error: e, gameId };
  }
  return 0;
}

// ── Traitement d'un lot de parties (parallèle si exemption) ───────────────────
async function processGames(games, seen, runs, runIds) {
  const unseen = games.filter(g => g.game && !seen.has(g.game));
  if (unseen.length === 0) return 0;

  let newRuns = 0;
  let errors = 0;

  console.log(
    `[sync] ${unseen.length} parties à détailler (×${DETAIL_CONCURRENCY} parallèle${HAS_EXEMPTION ? ", mode rapide" : ""})`
  );

  for (let i = 0; i < unseen.length; i += DETAIL_CONCURRENCY) {
    const chunk = unseen.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(game => processOneGame(game, seen, runs, runIds))
    );
    for (const r of results) {
      if (typeof r === "number") newRuns += r;
      else if (r?.error) {
        errors++;
        if (errors <= 5) console.warn(`[sync] ⚠️ ${r.gameId}: ${r.error.message}`);
      }
    }
    if (BATCH_DELAY_NORMAL > 0) await sleep(BATCH_DELAY_NORMAL);
  }

  if (errors > 5) console.log(`[sync] ... et ${errors - 5} autres erreurs`);
  return newRuns;
}

async function fetchGameDetail(gameId) {
  return fetchWithRetry(`${API_BASE}/public/game/${gameId}?turns=false`);
}

// ── Sync normale (dernières 3h) ───────────────────────────────────────────────
async function syncRecent() {
  console.log(`[sync] 🔄 Sync récente — ${new Date().toISOString()}`);
  const seen = loadSeen();
  const runs = loadRuns();
  const runIds = new Set(runs.map(r => r.id));
  let totalNew = 0;

  const now = new Date();
  const cp = loadCheckpoints();
  const lastSync = cp.last_sync_time ? parseInt(cp.last_sync_time, 10) : 0;
  const agoMs = Math.max(now.getTime() - RECENT_MAX_MS, lastSync - RECENT_OVERLAP_MS);
  const ago = new Date(agoMs);
  const windowMin = Math.round((now - ago) / 60_000);

  const windows = buildWindows30s(ago, now);
  console.log(
    `[sync] ${windows.length} fenêtres de 30s (~${windowMin} min, max 3h, filtre Public FFA ≥10p)`
  );

  for (const { start, end } of windows) {
    const games = await fetchGamesInWindow(start, end);
    if (games.length > 0) {
      if (games.length >= WINDOW_SATURATION_THRESHOLD) {
        console.log(
          `[sync] ⚠️ Fenêtre saturée (${games.length}) ${start.toISOString().slice(11, 19)} — possible troncature`
        );
      }
      totalNew += await processGames(games, seen, runs, runIds);
    }
    if (WINDOW_DELAY > 0) await sleep(WINDOW_DELAY);
  }

  if (totalNew > 0) saveRuns(runs);
  saveSeen(seen);

  cp.last_sync_time = String(Date.now());
  saveCheckpoints(cp);

  logApiStats("sync-recent");
  console.log(`[sync] ✅ Sync récente terminée — ${totalNew} nouveaux runs`);
  return totalNew;
}

function countHistoryWindows(rangeStartMs, rangeEndMs) {
  return Math.max(0, Math.ceil((rangeEndMs - rangeStartMs) / WINDOW_MS));
}

/** État de la sync (checkpoint, fenêtres, playerId, etc.) */
function printSyncStatus(cp = loadCheckpoints()) {
  const runs = loadRuns();
  const now = Date.now();
  const oldest = TARGET_DATE;
  const saved = cp.history_oldest_reached ? parseInt(cp.history_oldest_reached, 10) : now;
  const totalWindows = countHistoryWindows(oldest, now);
  const remainingWindows = countHistoryWindows(oldest, saved);
  const historyPct = totalWindows
    ? Math.round(((now - saved) / (now - oldest)) * 100)
    : 100;
  const withPlayerId = runs.filter((r) => r.playerId).length;
  const lastSync = cp.last_sync_time
    ? new Date(parseInt(cp.last_sync_time, 10)).toISOString()
    : "—";

  let seenCount = 0;
  try {
    seenCount = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).length;
  } catch { /* */ }

  const historyDone = saved <= oldest + WINDOW_MS * 2;

  console.log("\n📍 ÉTAT DE LA SYNC");
  console.log("═══════════════════════════════════════");
  console.log(`Runs en base:        ${runs.length.toLocaleString()}`);
  console.log(`Avec clientID:     ${withPlayerId.toLocaleString()} (${Math.round((withPlayerId / runs.length) * 100) || 0}%)`);
  console.log(`Parties vues (seen): ${seenCount.toLocaleString()}`);
  console.log(`Dernière sync récente: ${lastSync}`);
  console.log(`Exemption Skailex: ${HAS_EXEMPTION ? "oui" : "non"}`);
  console.log(`Fenêtre historique:  ${DEFAULT_HISTORY_WINDOWS} max / run (${HAS_EXEMPTION ? "exemption" : "sans exemption"})`);
  console.log("");
  console.log(`Cible historique:    ${new Date(oldest).toISOString().slice(0, 10)} → maintenant`);
  console.log(`Checkpoint (plus vieux traité): ${new Date(saved).toISOString()}`);
  console.log(`Fenêtres 30s totales:  ~${totalWindows.toLocaleString()}`);
  console.log(`Fenêtres restantes:    ~${remainingWindows.toLocaleString()} (recul depuis maintenant)`);
  console.log(`Avancement historique: ~${historyPct}%`);
  console.log(`Fenêtres saturées (cumul): ${cp.history_saturated_windows || 0}`);
  if (historyDone) {
    console.log("\n⚠️  Historique marqué COMPLET — des parties peuvent manquer (429 / fenêtres saturées).");
    console.log("   Pour rescanner: node sync.js reset-history  puis  node sync.js history 500");
  }
  console.log("═══════════════════════════════════════\n");
}

// ── Sync historique avec checkpoint ──────────────────────────────────────────
async function syncHistory(maxWindows = DEFAULT_HISTORY_WINDOWS) {
  const cp = loadCheckpoints();
  const oldest = TARGET_DATE;
  const now = Date.now();

  const saved = cp.history_oldest_reached;
  const resumeFrom = saved ? Math.max(parseInt(saved) - WINDOW_MS, oldest) : now;

  printSyncStatus(cp);

  if (parseInt(saved) <= oldest + WINDOW_MS * 2) {
    console.log(`[history] ✅ Historique complet jusqu'au ${new Date(oldest).toISOString().slice(0, 10)}`);
    console.log("[history] Utilise reset-history puis history 500 pour rescanner les trous.");
    return 0;
  }

  console.log(`[history] 🕐 Reprise depuis ${new Date(resumeFrom).toISOString()}`);

  const rangeEnd = new Date(resumeFrom);
  const rangeStart = new Date(oldest);
  const windows = buildWindows30s(rangeStart, rangeEnd);

  const toProcess = Math.min(windows.length, maxWindows);
  console.log(`[history] ${windows.length.toLocaleString()} fenêtres restantes — traitement de ${toProcess} (max ${maxWindows})`);

  const seen = loadSeen();
  const runs = loadRuns();
  const runIds = new Set(runs.map(r => r.id));
  let totalRuns = 0;
  let oldestReached = resumeFrom;
  let saturatedWindows = 0;

  for (let i = 0; i < toProcess; i++) {
    const { start, end } = windows[i];
    try {
      const games = await fetchGamesInWindow(start, end);
      if (games.length > 0) {
        if (games.length >= WINDOW_SATURATION_THRESHOLD) {
          saturatedWindows++;
          if (saturatedWindows <= 3) {
            console.log(
              `[history] ⚠️ Fenêtre saturée (${games.length}): ${start.toISOString().slice(0, 16)}`
            );
          }
        }
        const added = await processGames(games, seen, runs, runIds);
        totalRuns += added;
        if (added > 0) {
          console.log(`[history] +${added} runs (${start.toISOString().slice(0, 10)} ${start.toISOString().slice(11, 16)})`);
        }
      }
      oldestReached = end.getTime();
    } catch (e) {
      console.warn(`[history] ⚠️ Erreur fenêtre ${start.toISOString()}: ${e.message}`);
    }

    if (WINDOW_DELAY > 0) await sleep(WINDOW_DELAY);

    // Checkpoint périodique
    if ((i + 1) % CHECKPOINT_EVERY === 0 || i === toProcess - 1) {
      cp.history_oldest_reached = String(oldestReached);
      cp.history_saturated_windows = (cp.history_saturated_windows || 0) + saturatedWindows;
      saveCheckpoints(cp);
      saveSeen(seen);
      if (totalRuns > 0) saveRuns(runs);

      const pct = Math.round(((now - oldestReached) / (now - oldest)) * 100);
      console.log(`[history] 💾 ${i + 1}/${toProcess} fenêtres — ${totalRuns} runs — ${pct}% de l'historique`);
    }
  }

  // Sauvegarde finale
  if (totalRuns > 0) saveRuns(runs);
  saveSeen(seen);

  if (saturatedWindows > 0) {
    console.log(`[history] ⚠️ ${saturatedWindows} fenêtres saturées détectées — certains runs ont peut-être été manqués`);
  }

  if (windows.length > maxWindows) {
    console.log(`[history] ⏹️ Limite atteinte — reprendra au prochain run (reste: ${(windows.length - toProcess).toLocaleString()} fenêtres)`);
  } else {
    console.log(`[history] ✅ Historique terminé — ${totalRuns} runs insérés`);
  }

  return totalRuns;
}

// ── Diagnostic : vérifie les trous dans la couverture temporelle ──────────────
async function diagnose() {
  const cp = loadCheckpoints();
  const runs = loadRuns();

  printSyncStatus(cp);

  console.log("📊 DIAGNOSTIC DU DATASET");
  console.log("═══════════════════════════════════════");
  console.log(`Total runs: ${runs.length.toLocaleString()}`);

  // Répartition par mois
  const byMonth = {};
  runs.forEach(r => {
    const k = r.timestamp ? r.timestamp.slice(0, 7) : "unknown";
    byMonth[k] = (byMonth[k] || 0) + 1;
  });
  console.log("\nRuns par mois:");
  Object.keys(byMonth).sort().forEach(k => {
    const bar = "█".repeat(Math.round(byMonth[k] / 200));
    console.log(`  ${k}: ${byMonth[k].toLocaleString().padStart(6)} ${bar}`);
  });

  // Top 10 maps
  const byMap = {};
  runs.forEach(r => { byMap[r.map] = (byMap[r.map] || 0) + 1; });
  const topMaps = Object.entries(byMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("\nTop 10 maps:");
  topMaps.forEach(([map, count]) => console.log(`  ${map.padEnd(30)} ${count.toLocaleString()}`));

  console.log("═══════════════════════════════════════\n");
}

/** Remet le curseur historique à maintenant pour rescanner (garde runs + seen). */
function resetHistoryCheckpoint() {
  const cp = loadCheckpoints();
  cp.history_oldest_reached = String(Date.now());
  cp.history_saturated_windows = 0;
  cp.history_rescan_at = new Date().toISOString();
  saveCheckpoints(cp);
  console.log("[reset-history] ✅ Curseur remis à maintenant — les parties déjà dans seen/ seront ignorées, les manquantes seront ajoutées.");
  printSyncStatus(cp);
}

// ── Enrich : backfill playerIds manquants et construit la player alias map ─────
async function enrichPlayerIds() {
  const runs = loadRuns();
  const missing = runs.filter(r => !r.playerId);
  console.log(`[enrich] ${missing.length} runs sans playerId sur ${runs.length} total`);

  if (missing.length === 0) {
    console.log("[enrich] ✅ Tous les runs ont déjà un playerId");
    await buildAliasMap(runs);
    return;
  }

  let fixed = 0, errors = 0;
  const ENRICH_BATCH = 250; // Nombre de runs traités par exécution
  
  const toProcess = missing.slice(0, ENRICH_BATCH);
  console.log(`[enrich] Traitement de ${toProcess.length} runs (max ${ENRICH_BATCH} par exécution)...`);

  for (const run of toProcess) {
    try {
      const raw = await fetchWithRetry(`${API_BASE}/public/game/${run.id}?turns=false`);
      const info = raw.info || raw;
      const players = info.players || [];
      const winner = info.winner;
      if (winner && Array.isArray(winner) && winner.length >= 2) {
        const wp = players.find(p => p.clientID === winner[1]);
        if (wp && wp.clientID) {
          run.playerId = wp.clientID;
          fixed++;
        }
      }
    } catch (e) {
      errors++;
    }
    await sleep(150);
  }

  console.log(`[enrich] ✅ ${fixed} runs enrichis, ${errors} erreurs`);
  if (missing.length > ENRICH_BATCH) {
    console.log(`[enrich] ⏳ Reste ${missing.length - ENRICH_BATCH} runs — relancer 'node sync.js enrich'`);
  }

  saveRuns(runs);
  await buildAliasMap(runs);
}

// ── Construit player_aliases.json : fusion par nom de base (sans tag de clan) ──
// Le playerId dans runs.json est un clientId de session (unique par run),
// on ne peut PAS fusionner par playerId. À la place, on groupe par nom de base
// (nom sans tags de clan [XXX]) pour fusionner les variantes :
// ex: "Skailex" + "[HZK] Skailex" → nom canonique = dernier pseudo utilisé
// Amélioration : on détecte aussi les noms qui contiennent le nom de base
// ex: "Skailex on YT", "fan de skailex" → fusionnés avec "Skailex"
async function buildAliasMap(runs) {
  console.log("[alias] Construction de la map de fusion des joueurs...");

  // 1. Grouper par nom de base (sans tags de clan [XXX])
  const byBaseName = {};
  runs.forEach(r => {
    if (!r.player) return;
    // Extraire le nom de base : enlever les préfixes [XXX]
    const baseName = r.player.replace(/^\[.*?\]\s*/, '').trim();
    if (!baseName) return;

    if (!byBaseName[baseName]) byBaseName[baseName] = { names: {}, lastTs: null, latestName: null };
    byBaseName[baseName].names[r.player] = (byBaseName[baseName].names[r.player] || 0) + 1;
    // Garder le pseudo de la run la plus récente
    if (r.timestamp && (!byBaseName[baseName].lastTs || r.timestamp > byBaseName[baseName].lastTs)) {
      byBaseName[baseName].lastTs = r.timestamp;
      byBaseName[baseName].latestName = r.player;
    }
  });

  // 1b. Fusion secondaire : noms qui contiennent un nom de base existant
  // ex: "Skailex on YT" contient "Skailex" → fusion
  // ex: "fan de skailex" contient "skailex" (insensible à la casse) → fusion
  // Mais on évite les faux positifs : le nom court doit être ≥4 chars ET
  // représenter ≥50% de la longueur du nom long (sinon "Skailex" contiendrait "Kai")
  const allBaseNames = Object.keys(byBaseName);
  const mergeTargets = {}; // baseName -> targetBaseName (celui qui l'absorbe)

  allBaseNames.forEach(name => {
    if (mergeTargets[name]) return; // Déjà fusionné
    const nameLower = name.toLowerCase();
    for (const existing of allBaseNames) {
      if (existing === name) continue;
      if (mergeTargets[existing]) continue;
      const existingLower = existing.toLowerCase();
      // Le nom existant doit être assez long pour être significatif
      if (existing.length < 4) continue;
      // Le nom court doit représenter au moins 50% de la longueur du nom long
      // pour éviter "Kai" dans "Skailex" (3/7 = 42% < 50%)
      if (existing.length / name.length < 0.5) continue;
      // Vérifier si l'un contient l'autre comme sous-chaîne
      if (nameLower !== existingLower && nameLower.includes(existingLower)) {
        // name contient existing → fusionner name dans existing
        if (!mergeTargets[name]) {
          mergeTargets[name] = existing;
        }
      }
    }
  });

  // Appliquer les fusions secondaires
  for (const [source, target] of Object.entries(mergeTargets)) {
    const sourceData = byBaseName[source];
    const targetData = byBaseName[target];
    if (!sourceData || !targetData) continue;

    // Fusionner les noms
    Object.entries(sourceData.names).forEach(([name, count]) => {
      targetData.names[name] = (targetData.names[name] || 0) + count;
    });
    // Garder le nom le plus récent
    if (sourceData.lastTs && (!targetData.lastTs || sourceData.lastTs > targetData.lastTs)) {
      targetData.lastTs = sourceData.lastTs;
      targetData.latestName = sourceData.latestName;
    }
    // Supprimer la source fusionnée
    delete byBaseName[source];
  }

  // 2. Construire la map finale — uniquement les joueurs avec plusieurs alias
  // Les noms sans variante n'ont pas besoin d'entrée (le frontend affiche le nom brut)
  const aliasMap = {};
  let fusedCount = 0;
  for (const [baseName, d] of Object.entries(byBaseName)) {
    const aliases = Object.keys(d.names);
    if (aliases.length <= 1) continue; // Pas de fusion nécessaire

    fusedCount++;
    const canonicalName = d.latestName; // Dernier pseudo utilisé = nom canonique
    const wins = Object.values(d.names).reduce((a, b) => a + b, 0);

    // Créer une entrée pour chaque variante
    aliases.forEach(alias => {
      aliasMap[alias] = { name: canonicalName, aliases, wins };
    });
    if (!aliasMap[baseName]) {
      aliasMap[baseName] = { name: canonicalName, aliases, wins };
    }
  }

  // 3. Écrire player_aliases.json + version gzippée
  fs.writeFileSync("player_aliases.json", JSON.stringify(aliasMap));
  try {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(aliasMap)));
    fs.writeFileSync("player_aliases.json.gz", gz);
  } catch (e) {
    console.warn("[alias] ⚠️ Impossible d'écrire player_aliases.json.gz:", e.message);
  }

  console.log(`[alias] ✅ ${fusedCount} joueurs fusionnés, ${Object.keys(aliasMap).length} entrées, fichier écrit`);
  console.log(`[alias] Exemples :`);
  Object.values(aliasMap).slice(0, 3).forEach(p => {
    if (p.aliases.length > 1) console.log(`  → ${p.name}: ${p.aliases.join(', ')}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function fetchLatestCommit() {
  try {
    const res = await fetch("https://api.github.com/repos/openfrontio/OpenFrontIO/commits/main", {
      headers: { "Accept": "application/vnd.github.v3+json" }
    });
    if (res.ok) {
      const data = await res.json();
      return {
        sha: data.sha,
        date: data.commit.author.date,
        message: data.commit.message
      };
    }
  } catch (e) {
    console.warn("[sync] ⚠️ Impossible de récupérer le dernier commit d'OpenFrontIO:", e.message);
  }
  return null;
}

/** Mesure le débit avant 429 — node sync.js benchmark */
async function benchmarkExemption() {
  if (!HAS_EXEMPTION) {
    console.log("[benchmark] OPENFRONT_SKAILEX_ACCESS requis");
    return;
  }
  resetApiStats();
  console.log("[benchmark] Enchaînement /public/games jusqu'aux 429…");
  const now = new Date();
  const ago = new Date(now.getTime() - 3_600_000);
  const t0 = Date.now();
  let i = 0;
  let first429 = null;

  for (i = 0; i < 500; i++) {
    const url =
      `${API_BASE}/public/games?start=${ago.toISOString()}&end=${now.toISOString()}` +
      `&${GAMES_LIST_FILTER}&limit=50`;
    const res = await openFrontFetch(url);
    if (res.status === 429) {
      first429 = i + 1;
      const retryAfter = res.headers.get("retry-after");
      console.log(`[benchmark] Premier 429 après ${first429} requêtes (Retry-After: ${retryAfter ?? "n/a"})`);
      break;
    }
    if (!res.ok) {
      console.log(`[benchmark] HTTP ${res.status} à la requête ${i + 1}`);
      break;
    }
    await res.json();
  }

  const sec = (Date.now() - t0) / 1000;
  logApiStats("benchmark");
  if (!first429) {
    console.log(`[benchmark] Aucun 429 sur ${i} requêtes en ${sec.toFixed(1)}s (~${(i / sec).toFixed(1)} req/s)`);
    console.log("[benchmark] Limite non atteinte — exemption probablement illimitée ou >500 req/burst");
  } else {
    console.log(`[benchmark] Débit avant limite: ~${(first429 / sec).toFixed(1)} req/s`);
  }
  console.log("[benchmark] Plafonds API fixes (exemption ou non): fenêtre 2j, 1000 jeux/requête");
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "full";

  console.log(`[sync] 🚀 Démarrage (mode: ${mode})`);
  if (process.env.OPENFRONT_SKAILEX_ACCESS) {
    console.log("[sync] 🔑 Exemption Skailex active");
  }
  currentLatestCommit = await fetchLatestCommit();

  resetApiStats();

  if (mode === "benchmark") {
    await benchmarkExemption();
    return;
  }

  if (mode === "diagnose" || mode === "status") {
    if (mode === "status") printSyncStatus();
    else await diagnose();
    return;
  }

  if (mode === "reset-history") {
    resetHistoryCheckpoint();
    return;
  }

  if (mode === "enrich") {
    await enrichPlayerIds();
    return;
  }

  if (mode === "alias") {
    const runs = loadRuns();
    await buildAliasMap(runs);
    return;
  }

  const runs = loadRuns();
  console.log(`[sync] ${runs.length.toLocaleString()} runs existants`);

  if (mode === "full" || mode === "recent") {
    await syncRecent();
  }

  if (mode === "history") {
    const maxW = resolveHistoryWindowLimit(args);
    await syncHistory(maxW);
    return;
  }

  if (mode === "full") {
    await syncHistory(resolveHistoryWindowLimit(args));
  }

  // Toujours reconstruire la map d'alias après une sync
  // pour que player_aliases.json reste à jour avec les nouveaux runs
  const aliasRuns = loadRuns();
  await buildAliasMap(aliasRuns);

  const finalRuns = loadRuns();
  const finalCount = Array.isArray(finalRuns) ? finalRuns.length : (finalRuns.totalCount || 0);
  logApiStats("sync-total");
  console.log(`[sync] 🏁 Terminé: ${finalCount.toLocaleString()} runs total`);
}

main().catch(e => {
  console.error("[sync] Fatal:", e);
  process.exit(1);
});
