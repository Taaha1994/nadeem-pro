const express    = require("express");
const axios      = require("axios");
const cheerio    = require("cheerio");
const cors       = require("cors");
const NodeCache  = require("node-cache");
const rateLimit  = require("express-rate-limit");

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1hr cache

app.use(cors({
  origin: [
    "https://nadeem-frontend-delta.vercel.app",
    "http://localhost:5173",
    /\.vercel\.app$/,
  ],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: true,
}));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60000, max: 30 });
app.use(limiter);

// ── HEADERS to avoid Transfermarkt blocking ────────────────────────────────
const TM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": "https://www.transfermarkt.co.uk/",
};

// ══════════════════════════════════════════════════════════════════════════
// SEARCH PLAYERS
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ results: [] });

  const cacheKey = `search_${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://www.transfermarkt.co.uk/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(q)}&Spieler_page=0`;
    const { data } = await axios.get(url, { headers: TM_HEADERS, timeout: 8000 });
    const $ = cheerio.load(data);

    const results = [];
    $(".items tbody tr").each((i, row) => {
      if (i > 9) return;
      const $row = $(row);
      const nameEl = $row.find("td.hauptlink a").first();
      const name   = nameEl.text().trim();
      const href   = nameEl.attr("href") || "";
      const club   = $row.find("td.zentriert img.tiny_wappen").attr("title") || $row.find("td").eq(4).text().trim();
      const pos    = $row.find("td").eq(1).text().trim();
      const age    = parseInt($row.find("td.zentriert").eq(1).text().trim()) || null;
      const nation = $row.find("td.zentriert img.flaggenrahmen").first().attr("title") || "";

      // Extract player ID from href e.g. /player-name/profil/spieler/12345
      const idMatch = href.match(/spieler\/(\d+)/);
      const playerId = idMatch ? idMatch[1] : null;

      if (name && playerId) {
        results.push({ id: playerId, name, club, position: pos, age, nationality: nation, href });
      }
    });

    const response = { results };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed", results: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET PLAYER PROFILE + INJURY HISTORY + AVAILABILITY
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/player/:id", async (req, res) => {
  const { id } = req.params;
  const cacheKey = `player_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // ── 1. Profile page ───────────────────────────────────────────────────
    const profileUrl = `https://www.transfermarkt.co.uk/x/profil/spieler/${id}`;
    const { data: profileHtml } = await axios.get(profileUrl, { headers: TM_HEADERS, timeout: 10000 });
    const $p = cheerio.load(profileHtml);

    const name        = $p("h1.data-header__headline-wrapper--wordwrap").text().trim() ||
                        $p(".data-header__headline-wrapper h1").text().trim();
    const position    = $p(".detail-position__position").text().trim() ||
                        $p("dd").filter((i,el)=>$p(el).prev("dt").text().includes("Position")).first().text().trim();
    const dobText     = $p("span[itemprop='birthDate']").text().trim();
    const nationality = $p("span[itemprop='nationality']").text().trim();
    const club        = $p("span.data-header__club a").text().trim() ||
                        $p(".data-header__club").text().trim();
    const foot        = $p("dd").filter((i,el)=>$p(el).prev("dt").text().toLowerCase().includes("foot")).first().text().trim();

    // Parse DOB → age
    let age = null;
    if (dobText) {
      const match = dobText.match(/(\w+ \d+, \d{4})|(\d{2}\.\d{2}\.\d{4})/);
      if (match) {
        const dob = new Date(dobText.replace(/\(.+\)/, "").trim());
        if (!isNaN(dob)) age = Math.floor((Date.now() - dob) / (365.25 * 24 * 3600 * 1000));
      }
    }

    // ── 2. Injury history ─────────────────────────────────────────────────
    const injuryUrl = `https://www.transfermarkt.co.uk/x/verletzungen/spieler/${id}`;
    const { data: injuryHtml } = await axios.get(injuryUrl, { headers: TM_HEADERS, timeout: 10000 });
    const $i = cheerio.load(injuryHtml);

    const injuries = [];
    $i(".items tbody tr").each((idx, row) => {
      const cells = $i(row).find("td");
      const season   = $i(cells[0]).text().trim();
      const injury   = $i(cells[1]).text().trim();
      const fromDate = $i(cells[2]).text().trim();
      const toDate   = $i(cells[3]).text().trim();
      const daysOut  = parseInt($i(cells[4]).text().trim()) || 0;
      const gamesOut = parseInt($i(cells[5]).text().trim()) || 0;

      if (injury && season) {
        injuries.push({ season, injury: injury.toLowerCase(), fromDate, toDate, daysOut, gamesOut });
      }
    });

    // ── 3. Appearances / availability by season ───────────────────────────
    const statsUrl = `https://www.transfermarkt.co.uk/x/leistungsdaten/spieler/${id}/plus/0?saison=ges`;
    const { data: statsHtml } = await axios.get(statsUrl, { headers: TM_HEADERS, timeout: 10000 });
    const $s = cheerio.load(statsHtml);

    const seasonStats = [];
    $s(".items tbody tr").each((idx, row) => {
      const cells = $s(row).find("td");
      if (cells.length < 5) return;
      const season    = $s(cells[0]).text().trim();
      const apps      = parseInt($s(cells[2]).text().trim()) || 0;
      const mins      = parseInt($s(cells[5]).text().trim().replace(/[^0-9]/g,"")) || 0;
      if (season.match(/\d{2}\/\d{2}/) && apps > 0) {
        seasonStats.push({ season, apps, mins });
      }
    });

    // Sort most recent first
    seasonStats.sort((a, b) => b.season.localeCompare(a.season));

    // ── 4. Derive Nadeem Score inputs ─────────────────────────────────────
    const now   = new Date();
    const threeYearsAgo = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate());

    // Injury flags
    const hasACL         = injuries.some(inj => /acl|anterior cruciate|cruciate ligament/.test(inj.injury));
    const hasMajorSurgery= injuries.some(inj => /meniscus|achilles|hip labr|hip replace|capsulitis/.test(inj.injury));
    const hasHamstring   = injuries.some(inj => /hamstring/.test(inj.injury));

    // Recurrent injuries in last 3 years
    const recentInjuries = injuries.filter(inj => {
      const d = new Date(inj.fromDate);
      return !isNaN(d) && d >= threeYearsAgo && inj.daysOut >= 7;
    });
    const recurrent      = recentInjuries.length >= 2;

    // Current injury — most recent season had injury that ended recently or is ongoing
    const mostRecentInj  = injuries[0];
    const currentlyInjured = mostRecentInj && mostRecentInj.toDate === "-";

    // Last season apps
    const lastSeasonApps = seasonStats[0]?.apps || 0;
    const prevSeasonApps = seasonStats[1]?.apps || 0;
    const prevPrevApps   = seasonStats[2]?.apps || 0;

    // High load — check if any season had 50+ apps (across comps — TM shows per competition so sum)
    // For safety, check if a single competition entry shows high mins suggesting heavy load
    const highLoad = seasonStats[0]?.apps >= 40; // proxy — TM shows competition by competition

    // ── 5. Availability trend (3 seasons) ────────────────────────────────
    const trend = [prevPrevApps, prevSeasonApps, lastSeasonApps].filter(n => n > 0);
    let trendDirection = "stable";
    if (trend.length >= 2) {
      const delta = trend[trend.length - 1] - trend[0];
      if (delta >= 5)       trendDirection = "improving";
      else if (delta <= -5) trendDirection = "declining";
    }

    // ── 6. Compute Nadeem Score ───────────────────────────────────────────
    let nadeemScore = 0;
    const flags = {};

    flags.age30 = age !== null && age >= 30;
    flags.age33 = age !== null && age >= 33;
    flags.age21 = age !== null && age <= 21;
    flags.acl          = hasACL;
    flags.majorsurgery = hasMajorSurgery;
    flags.hamstring    = hasHamstring;
    flags.recurrent    = recurrent;
    flags.currentinjury= currentlyInjured;
    flags.tendinopathy = injuries.some(inj => /tendin|tendon/.test(inj.injury) && inj.toDate === "-");
    flags.avail20      = lastSeasonApps < 20 && lastSeasonApps > 0;
    flags.avail10      = lastSeasonApps < 10 && lastSeasonApps > 0;
    flags.highload     = highLoad;

    if (flags.age30)        nadeemScore += 1;
    if (flags.age33)        nadeemScore += 1;
    if (flags.age21)        nadeemScore += 1;
    if (flags.acl)          nadeemScore += 2;
    if (flags.majorsurgery) nadeemScore += 1;
    if (flags.hamstring)    nadeemScore += 1;
    if (flags.recurrent)    nadeemScore += 1;
    if (flags.currentinjury)nadeemScore += 2;
    if (flags.tendinopathy) nadeemScore += 1;
    if (flags.avail20)      nadeemScore += 1;
    if (flags.avail10)      nadeemScore += 1;
    if (flags.highload)     nadeemScore += 1;

    // ── 7. Availability Prediction Algorithm ─────────────────────────────
    const availability = predictAvailability({
      nadeemScore,
      age,
      lastSeasonApps,
      prevSeasonApps,
      prevPrevApps,
      trendDirection,
      injuries,
      flags,
    });

    const result = {
      id,
      name,
      position,
      age,
      nationality,
      club,
      foot,
      injuries,
      seasonStats: seasonStats.slice(0, 5),
      flags,
      nadeemScore,
      nadeemMax: 13,
      availability,
      trendDirection,
      lastSeasonApps,
      dataCompleteness: calcDataCompleteness(name, age, injuries, seasonStats, flags),
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("Player fetch error:", err.message);
    res.status(500).json({ error: "Could not fetch player data", details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AVAILABILITY PREDICTION ALGORITHM
// ══════════════════════════════════════════════════════════════════════════
function predictAvailability({ nadeemScore, age, lastSeasonApps, prevSeasonApps, prevPrevApps, trendDirection, injuries, flags }) {
  const SEASON_GAMES = 46; // Championship season

  // ── Base availability from Nadeem Score ───────────────────────────────
  // Score 0 → ~90% base, Score 13 → ~35% base
  const scoreBasePct = 90 - (nadeemScore * 4.2);

  // ── Trend adjustment ──────────────────────────────────────────────────
  let trendAdj = 0;
  const seasons = [prevPrevApps, prevSeasonApps, lastSeasonApps].filter(n => n > 0);
  if (seasons.length >= 2) {
    if (trendDirection === "improving") trendAdj = +5;
    if (trendDirection === "declining") trendAdj = -8;
  }

  // ── Age curve adjustment ──────────────────────────────────────────────
  let ageAdj = 0;
  if (age !== null) {
    if (age <= 21) ageAdj = -4;  // development risk
    if (age >= 30) ageAdj = -3;
    if (age >= 33) ageAdj = -6;
    if (age >= 36) ageAdj = -10;
    if (age >= 22 && age <= 28) ageAdj = +3; // peak years
  }

  // ── Injury recency weighting ──────────────────────────────────────────
  let injuryRecencyAdj = 0;
  const now = new Date();
  injuries.forEach(inj => {
    const d = new Date(inj.fromDate);
    if (isNaN(d)) return;
    const monthsAgo = (now - d) / (1000 * 60 * 60 * 24 * 30);
    if (monthsAgo < 6)  injuryRecencyAdj -= 10;
    else if (monthsAgo < 12) injuryRecencyAdj -= 6;
    else if (monthsAgo < 24) injuryRecencyAdj -= 2;
  });
  injuryRecencyAdj = Math.max(injuryRecencyAdj, -15); // floor

  // ── Historical availability anchor ────────────────────────────────────
  let historicalAdj = 0;
  if (seasons.length >= 2) {
    const avgApps = seasons.reduce((a, b) => a + b, 0) / seasons.length;
    const avgPct  = (avgApps / SEASON_GAMES) * 100;
    historicalAdj = (avgPct - 70) * 0.3; // pulls toward historical average
  }

  // ── Compose final prediction ──────────────────────────────────────────
  let central = scoreBasePct + trendAdj + ageAdj + injuryRecencyAdj + historicalAdj;
  central = Math.min(95, Math.max(15, central));

  // Confidence interval — wider when less data
  const dataPoints  = seasons.length + (injuries.length > 0 ? 1 : 0);
  const ciWidth     = dataPoints >= 4 ? 6 : dataPoints >= 2 ? 9 : 13;

  const low     = Math.round(Math.max(10, central - ciWidth));
  const high    = Math.round(Math.min(96, central + ciWidth));
  const central_= Math.round(central);

  const gamesLow  = Math.round((low / 100)  * SEASON_GAMES);
  const gamesMid  = Math.round((central_ / 100) * SEASON_GAMES);
  const gamesHigh = Math.round((high / 100) * SEASON_GAMES);

  // Confidence label
  let confidence = "Low";
  if (dataPoints >= 5) confidence = "High";
  else if (dataPoints >= 3) confidence = "Moderate";

  // Risk label
  let riskLabel = "Very High Risk";
  let riskColor = "#ef4444";
  if (central_ >= 80) { riskLabel = "Low Risk";       riskColor = "#22c55e"; }
  else if (central_ >= 65) { riskLabel = "Moderate Risk";  riskColor = "#E0A92C"; }
  else if (central_ >= 50) { riskLabel = "High Risk";      riskColor = "#f97316"; }

  return {
    pctLow: low, pctMid: central_, pctHigh: high,
    gamesLow, gamesMid, gamesHigh,
    confidence, riskLabel, riskColor,
    components: { scoreBase: Math.round(scoreBasePct), trendAdj, ageAdj, injuryRecencyAdj: Math.round(injuryRecencyAdj), historicalAdj: Math.round(historicalAdj) },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// DATA COMPLETENESS SCORE
// ══════════════════════════════════════════════════════════════════════════
function calcDataCompleteness(name, age, injuries, seasonStats, flags) {
  let score = 0;
  let total = 5;
  if (name)             score++;
  if (age)              score++;
  if (injuries.length)  score++;
  if (seasonStats.length >= 2) score++;
  if (seasonStats.length >= 3) score++;
  return Math.round((score / total) * 100);
}

// ══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/health", (req, res) => res.json({ status: "ok", version: "1.0.0" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Nadeem API running on port ${PORT}`));
