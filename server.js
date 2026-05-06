const express   = require("express");
const axios     = require("axios");
const cheerio   = require("cheerio");
const cors      = require("cors");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });

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

const TM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": "https://www.transfermarkt.co.uk/",
};

// ══════════════════════════════════════════════════════════════════════════
// SEARCH
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
      const $row   = $(row);
      const nameEl = $row.find("td.hauptlink a").first();
      const name   = nameEl.text().trim();
      const href   = nameEl.attr("href") || "";
      const club   = $row.find("td.zentriert img.tiny_wappen").attr("title") || "";
      const pos    = $row.find("td").eq(1).text().trim();
      const age    = parseInt($row.find("td.zentriert").eq(1).text().trim()) || null;
      const nation = $row.find("td.zentriert img.flaggenrahmen").first().attr("title") || "";
      const idM    = href.match(/spieler\/(\d+)/);
      if (name && idM) results.push({ id: idM[1], name, club, position: pos, age, nationality: nation });
    });
    const response = { results };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "Search failed", results: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PLAYER PROFILE
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/player/:id", async (req, res) => {
  const { id } = req.params;
  const cacheKey = `player_v4_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // ── 1. Profile ────────────────────────────────────────────────────────
    const { data: pH } = await axios.get(`https://www.transfermarkt.co.uk/x/profil/spieler/${id}`, { headers: TM_HEADERS, timeout: 10000 });
    const $p = cheerio.load(pH);
    const name     = $p("h1.data-header__headline-wrapper--wordwrap").text().trim() || $p(".data-header__headline-wrapper h1").text().trim();
    const position = $p(".detail-position__position").text().trim();
    const dobText  = $p("span[itemprop='birthDate']").text().trim();
    const nationality = $p("span[itemprop='nationality']").text().trim();
    const club     = $p("span.data-header__club a").text().trim();

    let age = null;
    if (dobText) {
      const dob = new Date(dobText.replace(/\(.+\)/, "").trim());
      if (!isNaN(dob)) age = Math.floor((Date.now() - dob) / (365.25 * 24 * 3600 * 1000));
    }

    // ── 2. Injury history ─────────────────────────────────────────────────
    const { data: iH } = await axios.get(`https://www.transfermarkt.co.uk/x/verletzungen/spieler/${id}`, { headers: TM_HEADERS, timeout: 10000 });
    const $i = cheerio.load(iH);
    const injuries = [];
    $i(".items tbody tr").each((idx, row) => {
      const c = $i(row).find("td");
      const season = $i(c[0]).text().trim();
      const injury = $i(c[1]).text().trim();
      const from   = $i(c[2]).text().trim();
      const to     = $i(c[3]).text().trim();
      const days   = parseInt($i(c[4]).text().trim()) || 0;
      const games  = parseInt($i(c[5]).text().trim()) || 0;
      if (injury && season) injuries.push({ season, injury: injury.toLowerCase(), fromDate: from, toDate: to, daysOut: days, gamesOut: games });
    });

    // ── 3. Per-season stats (accurate — fetch each season separately) ─────
    const currentYear = new Date().getFullYear();
    const seasonStats = [];

    for (let y = currentYear; y >= currentYear - 4; y--) {
      const seasonCode = String(y - 1);
      try {
        const { data: sH } = await axios.get(
          `https://www.transfermarkt.co.uk/x/leistungsdaten/spieler/${id}/plus/0?saison=${seasonCode}`,
          { headers: TM_HEADERS, timeout: 8000 }
        );
        const $s = cheerio.load(sH);
        let totalApps = 0, totalMins = 0;
        $s(".items tbody tr").each((idx, row) => {
          const c = $s(row).find("td");
          if (c.length < 6) return;
          totalApps += parseInt($s(c[2]).text().trim()) || 0;
          totalMins += parseInt($s(c[5]).text().trim().replace(/[^0-9]/g, "")) || 0;
        });
        if (totalApps > 0) {
          const label    = `${String(y-1).slice(-2)}/${String(y).slice(-2)}`;
          const possMin  = 4140; // 46 × 90
          const availPct = Math.min(100, Math.round((totalMins / possMin) * 100));
          seasonStats.push({ season: label, apps: totalApps, mins: totalMins, availPct });
        }
      } catch (e) { /* season unavailable */ }
    }

    // ── 4. Aggregate injury metrics ───────────────────────────────────────
    const recentLabels = seasonStats.slice(0, 3).map(s => s.season);
    const injDaysBySeason  = {};
    const injCountBySeason = {};
    injuries.forEach(inj => {
      injDaysBySeason[inj.season]  = (injDaysBySeason[inj.season]  || 0) + inj.daysOut;
      injCountBySeason[inj.season] = (injCountBySeason[inj.season] || 0) + 1;
    });
    const avgInjuryDays  = recentLabels.length
      ? recentLabels.reduce((s, l) => s + (injDaysBySeason[l]  || 0), 0) / recentLabels.length : 0;
    const avgInjuryCount = recentLabels.length
      ? recentLabels.reduce((s, l) => s + (injCountBySeason[l] || 0), 0) / recentLabels.length : 0;
    const longestAbsence = injuries.reduce((m, i) => Math.max(m, i.daysOut), 0);

    // ── 5. Nadeem Score ───────────────────────────────────────────────────
    const cutoff3yr = new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000);
    const recentInjuries = injuries.filter(inj => {
      const d = new Date(inj.fromDate);
      return !isNaN(d) && d >= cutoff3yr && inj.daysOut >= 7;
    });
    const lastApps = seasonStats[0]?.apps || 0;

    const flags = {
      age30:        age !== null && age >= 30,
      age33:        age !== null && age >= 33,
      age21:        age !== null && age <= 21,
      acl:          injuries.some(i => /acl|anterior cruciate|cruciate ligament/.test(i.injury)),
      majorsurgery: injuries.some(i => /meniscus|achilles|hip labr|hip replace/.test(i.injury)),
      hamstring:    injuries.some(i => /hamstring/.test(i.injury)),
      recurrent:    recentInjuries.length >= 2,
      currentinjury:injuries[0]?.toDate === "-",
      tendinopathy: injuries.some(i => /tendin|tendon/.test(i.injury) && i.toDate === "-"),
      avail20:      lastApps > 0 && lastApps < 20,
      avail10:      lastApps > 0 && lastApps < 10,
      highload:     lastApps >= 40,
    };

    let nadeemScore = 0;
    if (flags.age30)         nadeemScore += 1;
    if (flags.age33)         nadeemScore += 1;
    if (flags.age21)         nadeemScore += 1;
    if (flags.acl)           nadeemScore += 2;
    if (flags.majorsurgery)  nadeemScore += 1;
    if (flags.hamstring)     nadeemScore += 1;
    if (flags.recurrent)     nadeemScore += 1;
    if (flags.currentinjury) nadeemScore += 2;
    if (flags.tendinopathy)  nadeemScore += 1;
    if (flags.avail20)       nadeemScore += 1;
    if (flags.avail10)       nadeemScore += 1;
    if (flags.highload)      nadeemScore += 1;

    // ── 6. Availability Index ─────────────────────────────────────────────
    const availIndex = calcAvailabilityIndex({ seasonStats, avgInjuryDays, avgInjuryCount, longestAbsence });

    // ── 7. Unified Signing Risk ───────────────────────────────────────────
    const signingRisk = calcSigningRisk({ nadeemScore, availIndex, age, seasonStats, injuries });

    const result = {
      id, name, position, age, nationality, club,
      injuries, seasonStats, flags,
      nadeemScore, nadeemMax: 13,
      availIndex, signingRisk,
      lastSeasonApps: lastApps,
      avgInjuryDays:  Math.round(avgInjuryDays),
      avgInjuryCount: Math.round(avgInjuryCount * 10) / 10,
      longestAbsence,
      dataCompleteness: calcDataCompleteness(name, age, injuries, seasonStats),
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("Player error:", err.message);
    res.status(500).json({ error: "Could not fetch player data", details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AVAILABILITY INDEX  (0–10, higher = better availability)
// ══════════════════════════════════════════════════════════════════════════
function calcAvailabilityIndex({ seasonStats, avgInjuryDays, avgInjuryCount, longestAbsence }) {
  let score = 10;
  const breakdown = {};

  // Weighted availability % (recent seasons weighted more)
  const W = [3, 2, 1];
  let weightedPct = null;
  if (seasonStats.length > 0) {
    const wSum = seasonStats.slice(0, 3).reduce((s, st, i) => s + st.availPct * (W[i] || 1), 0);
    const wTot = seasonStats.slice(0, 3).reduce((s, st, i) => s + (W[i] || 1), 0);
    weightedPct = Math.round(wSum / wTot);

    const d = weightedPct >= 85 ? 0
            : weightedPct >= 70 ? 1.0
            : weightedPct >= 55 ? 2.5
            : weightedPct >= 40 ? 4.0 : 5.0;
    score -= d;
    breakdown.weightedAvailability = { value: weightedPct + "%", deduction: -d };
  }

  // Average injury days
  const d2 = avgInjuryDays < 14 ? 0
           : avgInjuryDays < 30 ? 0.5
           : avgInjuryDays < 60 ? 1.0
           : avgInjuryDays < 90 ? 1.5 : 2.0;
  score -= d2;
  breakdown.avgInjuryDays = { value: Math.round(avgInjuryDays) + " days/season", deduction: -d2 };

  // Injury frequency
  const d3 = avgInjuryCount < 0.5 ? 0
           : avgInjuryCount < 1.0 ? 0.5
           : avgInjuryCount < 2.0 ? 1.0 : 1.5;
  score -= d3;
  breakdown.injuryFrequency = { value: avgInjuryCount.toFixed(1) + "/season", deduction: -d3 };

  // Longest absence
  const d4 = longestAbsence < 30  ? 0
           : longestAbsence < 60  ? 0.5
           : longestAbsence < 120 ? 1.0 : 1.5;
  score -= d4;
  breakdown.longestAbsence = { value: longestAbsence + " days", deduction: -d4 };

  // Trend bonus/penalty
  let trendAdj = 0;
  if (seasonStats.length >= 3) {
    const delta = seasonStats[0].availPct - seasonStats[Math.min(2, seasonStats.length-1)].availPct;
    if (delta >= 15)  trendAdj = +0.5;
    if (delta <= -15) trendAdj = -0.5;
  }
  score += trendAdj;
  breakdown.trend = { value: trendAdj >= 0 ? `+${trendAdj}` : `${trendAdj}`, deduction: trendAdj };

  const final = Math.min(10, Math.max(0, Math.round(score * 10) / 10));
  const label = final >= 8.5 ? "Excellent" : final >= 7.0 ? "Good" : final >= 5.5 ? "Average" : final >= 4.0 ? "Poor" : "Very Poor";
  const color = final >= 8.5 ? "#4ade80" : final >= 7.0 ? "#86efac" : final >= 5.5 ? "#E0A92C" : final >= 4.0 ? "#fb923c" : "#f87171";
  return { score: final, max: 10, weightedAvailPct: weightedPct, breakdown, label, color };
}

// ══════════════════════════════════════════════════════════════════════════
// UNIFIED SIGNING RISK  (0–100, higher = more risk)
// 60% Nadeem Score  +  40% Availability Index
// ══════════════════════════════════════════════════════════════════════════
function calcSigningRisk({ nadeemScore, availIndex, age, seasonStats, injuries }) {
  const nadeemRisk = (nadeemScore / 13) * 100;
  const availRisk  = ((10 - availIndex.score) / 10) * 100;
  const combined   = Math.round(nadeemRisk * 0.60 + availRisk * 0.40);

  // Predicted availability — start from actual historical average then adjust
  let predPct = availIndex.weightedAvailPct !== null ? availIndex.weightedAvailPct : 68;
  predPct -= nadeemScore * 2.0; // clinical penalty
  if (age !== null) {
    if      (age >= 33) predPct -= 4;
    else if (age >= 30) predPct -= 2;
    else if (age <= 21) predPct -= 3;
    else if (age >= 22 && age <= 28) predPct += 2;
  }
  predPct = Math.min(92, Math.max(15, Math.round(predPct)));

  const dataPoints = seasonStats.length + (injuries.length > 0 ? 1 : 0);
  const ci = dataPoints >= 4 ? 5 : dataPoints >= 2 ? 8 : 12;
  const pctLow  = Math.max(10, predPct - ci);
  const pctHigh = Math.min(95, predPct + ci);
  const G = 46;

  // Risk band thresholds
  let riskBand, riskColor, recommendation;
  if      (combined <= 20) { riskBand="Minimal Risk";   riskColor="#4ade80"; recommendation="Ideal profile. Sign with confidence."; }
  else if (combined <= 35) { riskBand="Low Risk";        riskColor="#86efac"; recommendation="Good profile. Standard pre-signing medical sufficient."; }
  else if (combined <= 50) { riskBand="Moderate Risk";   riskColor="#E0A92C"; recommendation="Proceed with caution. Enhanced medical due diligence required. Consider availability-linked contract incentives."; }
  else if (combined <= 65) { riskBand="High Risk";       riskColor="#fb923c"; recommendation="High risk. Only sign if talent clearly justifies it. Short contract, performance clauses, and independent medical essential."; }
  else                     { riskBand="Very High Risk";  riskColor="#f87171"; recommendation="Very high risk. Avoid unless exceptional. Minimise financial exposure — low base wage, high appearance bonuses only."; }

  return {
    combinedRisk: combined,
    nadeemRisk: Math.round(nadeemRisk),
    availRisk:  Math.round(availRisk),
    riskBand, riskColor, recommendation,
    predictedAvailPct: predPct,
    pctLow, pctHigh,
    gamesLow:  Math.round((pctLow  / 100) * G),
    gamesMid:  Math.round((predPct / 100) * G),
    gamesHigh: Math.round((pctHigh / 100) * G),
    confidence: dataPoints >= 5 ? "High" : dataPoints >= 3 ? "Moderate" : "Low",
    weights: { nadeem: 60, availability: 40 },
  };
}

function calcDataCompleteness(name, age, injuries, seasonStats) {
  let s = 0;
  if (name)                    s += 20;
  if (age)                     s += 20;
  if (injuries.length > 0)     s += 20;
  if (seasonStats.length >= 2) s += 20;
  if (seasonStats.length >= 3) s += 20;
  return s;
}

app.get("/api/health", (req, res) => res.json({ status: "ok", version: "2.0.0" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Nadeem API v2 running on port ${PORT}`));
