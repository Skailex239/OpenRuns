import http from "http";
import { parse as parseUrl } from "url";
import fs from "fs";
import path from "path";
import { API_BASE, openFrontFetch, warnIfNoExemption } from "./openfront-api.js";

warnIfNoExemption();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const FETCH_TIMEOUT_MS = 10_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await openFrontFetch(url, { signal: controller.signal });

    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {}

      console.error(
        `[upstream] fetch failed: HTTP ${res.status} url=${url} body=${text.slice(0, 500)}`
      );

      const err = new Error(`HTTP ${res.status}`);
      err.upstreamStatus = res.status;
      err.upstreamUrl = url;
      err.upstreamBody = text;
      throw err;
    }

    return await res.json();
  } catch (e) {
    // timeout / abort
    if (e?.name === "AbortError") {
      const err = new Error(`Upstream timeout after ${FETCH_TIMEOUT_MS}ms`);
      err.upstreamStatus = 504;
      err.upstreamUrl = url;
      throw err;
    }

    // keep any upstream* fields if present
    if (e?.upstreamUrl == null) e.upstreamUrl = url;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// normalizeMap + extractSpeedrun copied from sync.js (kept minimal but consistent)
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
  "World":            "World",
  "Asia":             "Asia",
  "Africa":           "Africa",
  "Australia":        "Australia",
  "Iceland":          "Iceland",
  "North America":    "North America",
  "South America":    "South America",
  "Japan":            "Japan",
  "Italy":            "Italy",
  "Italia":           "Italia",
  "Britannia":        "Britannia",
  "Mars":             "Mars",
  "Pluto":            "Pluto",
  "Pangaea":          "Pangaea",
  "Alps":             "Alps",
  "Hawaii":           "Hawaii",
  "Arctic":           "Arctic",
  "Nile Delta":       "Nile Delta",
  "Amazon River":     "Amazon River",
  "Black Sea":        "Black Sea",
  "Bosphorus Straits":"Bosphorus Straits",
  "Bering Strait":    "Bering Strait",
  "Bering Sea":       "Bering Sea",
  "Strait of Gibraltar":"Strait of Gibraltar",
  "Strait of Hormuz": "Strait of Hormuz",
  "Between Two Seas": "Between Two Seas",
  "San Francisco":    "San Francisco",
  "New York City":    "New York City",
  "Montreal":         "Montreal",
  "Passage":          "Passage",
  "The Box":          "The Box",
  "Traders Dream":    "Traders Dream",
  "Yenisei":          "Yenisei",
  "Baikal":           "Baikal",
  "Gulf of St. Lawrence":"Gulf of St. Lawrence",
  "Gateway to the Atlantic":"Gateway to the Atlantic",
  "Falkland Islands": "Falkland Islands",
  "Faroe Islands":    "Faroe Islands",
  "Four Islands":     "Four Islands",
  "Lemnos":           "Lemnos",
  "Aegean":           "Aegean",
  "Halkidiki":        "Halkidiki",
  "Lisbon":           "Lisbon",
  "Mena":             "Mena",
  "Achiran":          "Achiran",
  "Svalmel":          "Svalmel",
  "Manicouagan":      "Manicouagan",
  "Sierpinski":       "Sierpinski",
  "Surrounded":       "Surrounded",
  "Two Lakes":        "Two Lakes",
  "Deglaciated Antarctica":"Deglaciated Antarctica",
  "World Rotated":    "World Rotated",
  "East Asia":        "East Asia",
  "Europe Classic":   "Europe Classic",
  "Britannia Classic":"Britannia Classic",
};

function normalizeMap(n) { return MAP_ALIASES[n] || n; }

const TIME_OFFSET_SECS = 32;

function extractSpeedrun(raw) {
  const detail = raw.info;
  if (!detail) return null;
  const config = detail.config || {};

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
    id: gameId,
    player: winnerPlayer.username,
    playerId: winnerPlayer.clientID,
    map: mapName,
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots: 400,
    players: humanPlayers.length,
    timestamp: detail.start
      ? new Date(detail.start > 1e10 ? detail.start : detail.start * 1000).toISOString()
      : new Date().toISOString(),
    url: `https://openfront.io/game/${gameId}`,
  };
}

function formatTime(durationSeconds) {
  const m = Math.floor(durationSeconds / 60);
  const s = String(durationSeconds % 60).padStart(2, "0");
  return `${m}m${s}s`;
}

async function getGamesInRange(startIso, endIso) {
  // Eviter tout double-encoding (source probable du HTTP 400)
  const qs = new URLSearchParams({ start: startIso, end: endIso });
  const url = `${API_BASE}/public/games?${qs.toString()}`;
  const data = await fetchWithTimeout(url);
  const games = Array.isArray(data) ? data : (data.games || []);
  return games.filter(g =>
    g.type === "Public" &&
    (g.mode === "Free For All" || g.mode === "FFA") &&
    (g.numPlayers == null || g.numPlayers >= 10)
  );
}

async function getTopRuns({ limit = 20, windowDays = 30 }) {
  const nowMs = Date.now();
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const startDate = new Date(windowStartMs);
  const endDate = new Date(nowMs);

  const segments = [];
  {
    // Chunking strict sur jours UTC (évite les erreurs de “24h”/arrondis)
    // On force segStart à 00:00:00Z puis segEnd à +1 jour (toujours à 00:00Z)
    const MAX_DAYS = 370; // garde-fou (un an max) pour éviter des appels trop lourds

    let cursor = new Date(startDate.toISOString());
    let endIso = endDate.toISOString();

    // aligner cursor sur 00:00 UTC
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 0, 0, 0, 0));

    let i = 0;
    while (cursor < endDate && i < MAX_DAYS) {
      const segStart = cursor.toISOString();
      const next = new Date(cursor.getTime());
      next.setUTCDate(next.getUTCDate() + 1);
      const segEndDate = (next > endDate ? endDate : next);
      const segEnd = new Date(segEndDate.getTime() - 1).toISOString(); // end strictement exclu (<24h)

      segments.push([segStart, segEnd]);

      cursor = next;
      i++;
    }
  }

  const games = [];
  const seenGameIds = new Set();

  let gamesFetchError = null;

  for (const [segStart, segEnd] of segments) {
    try {
      const segGames = await getGamesInRange(segStart, segEnd);
      for (const gg of segGames) {
        const id = gg?.game;
        if (!id) continue;
        if (seenGameIds.has(id)) continue;
        seenGameIds.add(id);
        games.push(gg);
      }
    } catch (e) {
      if (!gamesFetchError) {
        gamesFetchError = {
          segStart,
          segEnd,
          error: String(e?.message || e),
          errorName: e?.name,
          upstreamStatus: e?.upstreamStatus,
          upstreamUrl: e?.upstreamUrl,
          upstreamBody:
            typeof e?.upstreamBody === "string" ? e?.upstreamBody.slice(0, 2000) : undefined,
        };
      }
      // continue: on agrège ce qu'on a
    }
  }

  // Limit the number of game detail calls to keep it responsive
  const maxGameDetails = Math.min(200, Math.max(50, limit * 10));
  const picked = games.slice(0, maxGameDetails);

  const seenRunIds = new Set();
  const runs = [];

  // debug-only
  let gameFetchError = null;

  for (const g of picked) {
    const gameId = g.game;
    if (!gameId) continue;

    try {
      const raw = await fetchWithTimeout(`${API_BASE}/public/game/${gameId}`);
      const run = extractSpeedrun(raw);
      if (run && !seenRunIds.has(run.id)) {
        seenRunIds.add(run.id);
        runs.push(run);
      }
    } catch (e) {
      if (!gameFetchError) {
        gameFetchError = {
          gameId,
          error: String(e?.message || e),
          errorName: e?.name,
          upstreamStatus: e?.upstreamStatus,
          upstreamUrl: e?.upstreamUrl,
          upstreamBody:
            typeof e?.upstreamBody === "string" ? e.upstreamBody.slice(0, 2000) : undefined,
        };
      }
      // ignore individual failures; keep going
    }

    if (runs.length >= limit * 3) break;
    await sleep(120); // mild pacing
  }

  runs.sort((a, b) => a.duration_s - b.duration_s);
  return {
    runs: runs.slice(0, limit),
    debug: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      windowDays,
      segmentsCount: segments.length,
      gamesCount: games.length,
      pickedCount: picked.length,
      firstGameIds: picked.slice(0, 5).map(x => x.game).filter(Boolean),
      gamesFetchError,
      gameFetchError,
    },
  };
}

const STATIC_DIR = path.resolve(process.cwd());

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res, status, filePath, contentType) {
  try {
    const full = path.resolve(filePath);
    const data = fs.readFileSync(full);
    res.writeHead(status, {
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = parseUrl(req.url || "", true);
  const pathname = urlObj.pathname || "/";

  if (pathname === "/api/top-runs") {
    const limit = Number(urlObj.query.limit || 20);
    const windowDays = Number(urlObj.query.windowDays || 30);

    try {
      const runs = await getTopRuns({ limit, windowDays });
      sendJson(res, 200, { ok: true, runs, generatedAt: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: String(e?.message || e),
        errorName: e?.name,
        errorStack: typeof e?.stack === "string" ? e.stack.slice(0, 2000) : undefined,
        upstreamStatus: e?.upstreamStatus,
        upstreamUrl: e?.upstreamUrl,
        upstreamBody: typeof e?.upstreamBody === "string" ? e.upstreamBody.slice(0, 2000) : undefined,
      });
    }
    return;
  }

  // DEBUG uniquement: affiche le vrai body OpenFront sur /public/games
  if (pathname.startsWith("/api/openfront/")) {
    const subpath = pathname.slice("/api/openfront".length) || "/";
    const qs = urlObj.search || "";
    const upstreamUrl = `${API_BASE}${subpath}${qs}`;
    try {
      const data = await fetchWithTimeout(upstreamUrl);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(data));
    } catch (e) {
      sendJson(res, e?.upstreamStatus || 502, {
        ok: false,
        error: String(e?.message || e),
        upstreamUrl,
      });
    }
    return;
  }

  if (pathname === "/api/debug/upstream") {
    const startIso = urlObj.query.start;
    const endIso = urlObj.query.end;

    if (!startIso || !endIso) {
      sendJson(res, 400, { ok: false, error: "missing start/end query params" });
      return;
    }

    const qs = new URLSearchParams({ start: startIso, end: endIso });
    const upstreamUrl = `${API_BASE}/public/games?${qs.toString()}`;

    try {
      const data = await fetchWithTimeout(upstreamUrl);
      sendJson(res, 200, { ok: true, upstreamUrl, sample: Array.isArray(data) ? data.slice(0, 3) : data });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        upstreamUrl,
        error: String(e?.message || e),
        errorName: e?.name,
        upstreamStatus: e?.upstreamStatus,
        upstreamUrl: e?.upstreamUrl,
        upstreamBody: typeof e?.upstreamBody === "string" ? e.upstreamBody.slice(0, 2000) : undefined,
        errorStack: typeof e?.stack === "string" ? e.stack.slice(0, 2000) : undefined,
      });
    }
    return;
  }

  const staticMap = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/profile.html": ["profile.html", "text/html; charset=utf-8"],
    "/runs.html": ["runs.html", "text/html; charset=utf-8"],
    "/runs.js": ["runs.js", "text/javascript; charset=utf-8"],
    "/profile.js": ["profile.js", "text/javascript; charset=utf-8"],
    "/openfront-client.js": ["openfront-client.js", "text/javascript; charset=utf-8"],
    "/openfront-parse.js": ["openfront-parse.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/auth.css": ["auth.css", "text/css; charset=utf-8"],
    "/profile.css": ["profile.css", "text/css; charset=utf-8"],
    "/animations.css": ["animations.css", "text/css; charset=utf-8"],
    "/animations.js": ["animations.js", "text/javascript; charset=utf-8"],
    "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
    "/auth.js": ["auth.js", "text/javascript; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/player_aliases.json": ["player_aliases.json", "application/json; charset=utf-8"],
    "/player_aliases.json.gz": ["player_aliases.json.gz", "application/gzip"],
    "/maps_list.json": ["maps_list.json", "application/json; charset=utf-8"],
  };
  if (staticMap[pathname]) {
    const [file, type] = staticMap[pathname];
    sendFile(res, 200, path.join(STATIC_DIR, file), type);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});
