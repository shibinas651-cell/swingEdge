#!/usr/bin/env node
/**
 * Swing Oracle v5 — Best-in-class Indian Market Swing Analyzer
 *
 * Data pipeline:
 *  1. Yahoo Finance       → 1yr OHLCV candles (free)
 *  2. NSE /api/           → delivery%, VWAP, circuit limits (free)
 *  3. NSE option-chain    → PCR, max pain, OI levels (free)
 *  4. India VIX           → market regime (free)
 *  5. NSE market-status   → is market open? (free)
 *  6. NIFTY 50 context    → broad market trend (free)
 *  7. Technical engine    → RSI, MACD, EMA, BB, ATR, pivots
 *  8. Scoring engine      → weighted 100-pt multi-factor score
 *  9. Groq AI             → narrative analysis grounded in real data
 *
 * Zero npm packages. Pure Node.js built-ins.
 */

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const { fetchHistorical } = require("./marketData");
const { calculate }       = require("./indicators");
const { fetchAllNSEData } = require("./nseData");
const { scoreStock }      = require("./scoring");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT         || 3000;
const GROQ_KEY   = process.env.GROQ_API_KEY || "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";
const GROQ_MODEL = process.env.GROQ_MODEL   || "llama-3.3-70b-versatile";
const PUBLIC_DIR = path.resolve(__dirname, "public");

// Cache: 20 min TTL
const CACHE     = new Map();
const CACHE_TTL = 20 * 60 * 1000;

// ── Statics ───────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".css":  "text/css",
  ".ico":  "image/x-icon",
};
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found: " + filePath); }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data",  c  => (body += c));
    req.on("end",   () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

// ── Groq ──────────────────────────────────────────────────────────────────────
function callGroq(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.15, max_tokens: 1800, stream: false });
    const opts = {
      hostname: "api.groq.com",
      path:     "/openai/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${GROQ_KEY}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message || JSON.stringify(p.error)));
          resolve(p.choices?.[0]?.message?.content || "");
        } catch { reject(new Error("Failed to parse Groq response")); }
      });
    });
    req.on("error", err => reject(new Error("Groq: " + err.message)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Groq timed out")); });
    req.write(payload);
    req.end();
  });
}

function extractJSON(raw) {
  try { return JSON.parse(raw.trim()); } catch {}
  const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
  if (s !== -1 && e !== -1) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
  throw new Error("AI did not return valid JSON. Please retry.");
}

// ── Build AI prompt ───────────────────────────────────────────────────────────
function buildMessages(ticker, ind, nse, scoring, marketData) {
  const q  = nse.quote        || {};
  const oc = nse.optionChain  || {};
  const vx = nse.vix          || {};
  const nf = nse.niftyContext || {};
  const ev = nse.events       || [];

  const ctx = `
REAL-TIME MARKET DATA FOR ${ticker.toUpperCase()} — ${new Date().toLocaleDateString("en-IN", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}

━━ PRICE ━━
  Current Price  : ₹${ind.price?.last}   (${ind.price?.change >= 0 ? "+" : ""}${ind.price?.change}%)
  Open/High/Low  : ₹${ind.price?.open} / ₹${ind.price?.high} / ₹${ind.price?.low}
  VWAP           : ₹${q.vwap || "N/A"}   (Price ${ind.price?.last > q.vwap ? "ABOVE" : "BELOW"} VWAP — ${ind.price?.last > q.vwap ? "bullish intraday" : "bearish intraday"})
  52W High/Low   : ₹${ind.pos52w?.high52w} / ₹${ind.pos52w?.low52w}
  52W Position   : ${ind.pos52w?.positionPct}% (0=52w-low, 100=52w-high)
  Upper Circuit  : ₹${q.upperCircuit || "N/A"}   Lower Circuit: ₹${q.lowerCircuit || "N/A"}

━━ NSE MICROSTRUCTURE (Key Indian Signals) ━━
  Delivery %     : ${q.deliveryPct != null ? q.deliveryPct + "%" : "N/A"} ${q.deliveryPct >= 50 ? "⭐ HIGH — strong conviction" : q.deliveryPct >= 35 ? "(moderate)" : q.deliveryPct != null ? "⚠ LOW — speculative" : ""}
  Total Volume   : ${q.totalVolume?.toLocaleString("en-IN") || "N/A"}
  Volume vs Avg  : ${ind.volume?.ratio}x 20-day average ${ind.volume?.surge ? "⚡ SURGE" : ind.volume?.dry ? "🔇 DRY" : ""}
  PE Ratio       : ${q.pe || "N/A"}   Face Value: ₹${q.faceValue || "N/A"}
  FNO Stock      : ${q.isFNO ? "YES" : "NO"}

━━ TECHNICAL INDICATORS (${ind.candleCount} daily candles) ━━
  RSI (14)       : ${ind.rsi || "N/A"} ${ind.rsi > 70 ? "⚠ Overbought" : ind.rsi < 30 ? "⚠ Oversold" : ind.rsi > 55 ? "(bullish)" : "(neutral/bearish)"}
  MACD           : ${ind.macd ? `Line ${ind.macd.macd} | Signal ${ind.macd.signal} | Histogram ${ind.macd.histogram} → ${ind.macd.bullish ? "BULLISH" : "BEARISH"}` : "N/A"}
  EMA 20/50/200  : ₹${ind.trend?.ema20?.toFixed(1)} / ₹${ind.trend?.ema50?.toFixed(1)} / ₹${ind.trend?.ema200?.toFixed(1)}
  Trend          : ${ind.trend?.trend} (price ${ind.trend?.aboveEma20 ? "above" : "below"} EMA20, ${ind.trend?.aboveEma50 ? "above" : "below"} EMA50, ${ind.trend?.aboveEma200 ? "above" : "below"} EMA200)
  Bollinger      : ₹${ind.bb?.lower} — ₹${ind.bb?.mid} — ₹${ind.bb?.upper}  |  %B: ${ind.bb?.pctB}  |  Width: ${ind.bb?.width}% ${ind.bb?.squeeze ? "⚡ SQUEEZE" : ""}
  ATR (14)       : ₹${ind.atr} (${ind.atrPct}% of price)
  Momentum Score : ${ind.momentumScore}/10

━━ KEY LEVELS (Pivot-Based) ━━
  R2: ₹${ind.sr?.r2}   R1: ₹${ind.sr?.r1}   Pivot: ₹${ind.sr?.pivot}   S1: ₹${ind.sr?.s1}   S2: ₹${ind.sr?.s2}
${oc.pcr != null ? `
━━ OPTION CHAIN (Nearest Expiry: ${oc.nearExpiry}) ━━
  PCR            : ${oc.pcr} → ${oc.pcrSentiment}
  Max Pain       : ₹${oc.maxPainStrike} (expiry convergence zone)
  Max OI Call    : ₹${oc.maxCallOI_strike} (key resistance — wall of calls)
  Max OI Put     : ₹${oc.maxPutOI_strike} (key support — floor of puts)
  Total Call OI  : ${oc.totalCallOI?.toLocaleString("en-IN")}
  Total Put OI   : ${oc.totalPutOI?.toLocaleString("en-IN")}` : "  Option chain: Not available (non-FNO stock or data unavailable)"}

━━ INDIA VIX & BROAD MARKET ━━
  India VIX      : ${vx.value || "N/A"} ${vx.value ? "→ " + vx.signal : ""}
  NIFTY 50       : ${nf.value || "N/A"} (${nf.change >= 0 ? "+" : ""}${nf.change}%) — ${nf.trend || "N/A"}
${ev.length > 0 ? `
━━ UPCOMING CORPORATE EVENTS ━━
${ev.slice(0, 3).map(e => `  - ${e.subject} (${e.date})`).join("\n")}` : ""}

━━ MULTI-FACTOR SCORE ━━
  Total Score    : ${scoring.score100}/100 (${scoring.score10}/10)
  Verdict        : ${scoring.verdict}
  Confidence     : ${scoring.confidence} (${scoring.dataSources}/5 data sources available)
  Component Scores:
    Trend: ${scoring.scores.trend}/20  Momentum: ${scoring.scores.momentum}/20  Volatility: ${scoring.scores.volatility}/15
    Volume: ${scoring.scores.volume}/10  Delivery: ${scoring.scores.delivery}/15  Option Chain: ${scoring.scores.optionChain}/10  VIX: ${scoring.scores.vix}/10
  Key Reasons    : ${scoring.reasons.join(" | ")}
  Warnings       : ${scoring.warnings.join(" | ")}
`.trim();

  const system = `You are an elite swing trading analyst for the Indian stock market. 
You receive fully computed real-time market data and a quantitative score.
Your job is to write a sharp, specific, data-driven narrative analysis — NOT generic advice.
Every statement must reference actual numbers from the data above.
Respond ONLY with a valid JSON object. No markdown. No backticks. Start with { end with }.`;

  const user = `Based on the following real market data, write a swing trade analysis for ${ticker.toUpperCase()}:

${ctx}

Return ONLY this JSON (use actual numbers from the data above — do NOT make up values):
{
  "ticker": "${ticker.toUpperCase()}",
  "exchange": "${q.companyName ? "NSE" : "NSE"}",
  "company": "${q.companyName || marketData.fullName || ticker}",
  "sector": "${q.industry || q.sector || "N/A"}",
  "currentPrice": ${ind.price?.last},
  "priceChange": ${ind.price?.change?.toFixed(2)},
  "summary": "3 sharp sentences mentioning specific values: RSI ${ind.rsi}, delivery ${q.deliveryPct}%, VIX ${vx.value}, and what they collectively mean for a swing trade",
  "keyInsight": "The single most important signal for this stock right now in one sentence",
  "factors": {
    "trend":        { "rating": "${ind.trend?.trend === "BULLISH" ? "BULLISH" : ind.trend?.trend === "BEARISH" ? "BEARISH" : "NEUTRAL"}", "note": "EMAs: 20=₹${ind.trend?.ema20?.toFixed(0)} 50=₹${ind.trend?.ema50?.toFixed(0)} — specific implication" },
    "momentum":     { "rating": "${ind.rsi > 55 && ind.macd?.bullish ? "STRONG" : ind.rsi < 40 || !ind.macd?.bullish ? "WEAK" : "NEUTRAL"}", "note": "RSI ${ind.rsi} + MACD ${ind.macd?.bullish ? "bullish" : "bearish"} — what this means" },
    "delivery":     { "rating": "${q.deliveryPct >= 45 ? "HIGH" : q.deliveryPct >= 25 ? "MEDIUM" : "LOW"}", "note": "${q.deliveryPct != null ? q.deliveryPct + "% delivery" : "N/A"} — what this implies about intent" },
    "volatility":   { "rating": "${ind.atrPct > 3 ? "HIGH" : ind.atrPct > 1.5 ? "MEDIUM" : "LOW"}", "note": "ATR ₹${ind.atr} (${ind.atrPct}%) — stop loss sizing implication" },
    "optionSetup":  { "rating": "${oc.pcr > 1.0 ? "BULLISH" : oc.pcr < 0.7 ? "BEARISH" : "NEUTRAL"}", "note": "${oc.pcr != null ? "PCR " + oc.pcr + ", max pain ₹" + oc.maxPainStrike : "No F&O data"}" },
    "marketContext":{ "rating": "${vx.value < 16 ? "FAVOURABLE" : vx.value < 20 ? "NEUTRAL" : "UNFAVOURABLE"}", "note": "VIX ${vx.value || "N/A"}, NIFTY ${nf.trend || "N/A"} — macro implication for swing trade" }
  },
  "keyLevels": {
    "support": "₹${ind.sr?.s1} (Pivot S1)${oc.maxPutOI_strike ? " / ₹" + oc.maxPutOI_strike + " (Max Put OI)" : ""}",
    "resistance": "₹${ind.sr?.r1} (Pivot R1)${oc.maxCallOI_strike ? " / ₹" + oc.maxCallOI_strike + " (Max Call OI)" : ""}"
  },
  "stopLoss": "₹${ind.sr?.s2} area (below Pivot S2, ATR buffer ₹${ind.atr?.toFixed(0)})",
  "target1": "₹${ind.sr?.r1} (Pivot R1 — first target)",
  "target2": "₹${ind.sr?.r2} (Pivot R2 — extended target)",
  "riskReward": "calculate ratio: target1 vs stop loss from ₹${ind.price?.last}",
  "timeframe": "optimal swing window based on ATR and trend strength",
  "riskLevel": "${scoring.score100 >= 65 && vx.value < 20 ? "MEDIUM" : scoring.score100 < 45 || (vx.value >= 20) ? "HIGH" : "MEDIUM"}",
  "confidence": "${scoring.confidence}",
  "catalysts": [
    "data-driven insight 1 based on specific numbers above",
    "data-driven insight 2 based on delivery/volume/OI",
    "data-driven insight 3 or upcoming event if any"
  ],
  "avoid_if": "one specific condition from the data that would invalidate this trade",
  "disclaimer": "Not SEBI-registered advice. Data: Yahoo Finance + NSE. For educational use only."
}`;

  return [
    { role: "system", content: system },
    { role: "user",   content: user },
  ];
}

// ── Main analysis pipeline ────────────────────────────────────────────────────
async function analyzeStock(ticker) {
  const key = ticker.toUpperCase();

  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return { ...cached.data, cached: true, cacheAge: Math.round((Date.now() - cached.ts) / 60000) };

  // Run all data fetches in parallel
  const [histResult, nseResult] = await Promise.allSettled([
    fetchHistorical(ticker),
    fetchAllNSEData(ticker),
  ]);

  if (histResult.status === "rejected") throw new Error("Price data fetch failed: " + histResult.reason?.message);

  const marketData = histResult.value;
  const nseData    = nseResult.value || {};

  if (!marketData.candles || marketData.candles.length < 30) {
    throw new Error(`Insufficient data for "${ticker}". Ensure it's a valid NSE/BSE symbol (e.g. RELIANCE, TCS).`);
  }

  const indicators = calculate(marketData.candles);
  if (!indicators) throw new Error("Cannot calculate indicators — too few candles.");

  const scoring = scoreStock({ indicators, nseData });

  if (!GROQ_KEY) throw new Error("GROQ_API_KEY not set. Get free key at https://console.groq.com");

  const messages = buildMessages(ticker, indicators, nseData, scoring, marketData);
  const raw      = await callGroq(messages);
  const result   = extractJSON(raw);

  // ── Normalize verdict — ALWAYS use scoring engine, never trust AI string ──
  // AI models sometimes return "BUY", "SELL", "SWING_GOOD", etc.
  result.verdict    = scoring.verdict;   // GOOD | AVOID | NEUTRAL
  result.score      = scoring.score10;
  result.confidence = scoring.confidence;

  // Attach raw data for UI
  result.rawIndicators  = indicators;
  result.rawNSE         = nseData;
  result.scoring        = scoring;
  result.ohlcv          = marketData.candles.slice(-90).map(c => ({
    date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
  result.cached = false;

  CACHE.set(key, { ts: Date.now(), data: result });
  return result;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url, true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (pathname === "/api/analyze" && req.method === "POST") {
    try {
      const { ticker } = await parseBody(req);
      if (!ticker?.trim()) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Ticker required" })); }
      const result = await analyzeStock(ticker.trim());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ keySet: !!GROQ_KEY, model: GROQ_MODEL, version: "v5" }));
  }

  if (pathname === "/" || pathname === "/index.html") return serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
  const safe = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  serveStatic(res, safe);
});

server.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  🇮🇳  SWING ORACLE v5 — BEST-IN-CLASS               ║");
  console.log("║  Yahoo Finance + NSE Direct + Options + VIX + AI    ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n  App     → http://localhost:${PORT}`);
  console.log(`  Data    → Yahoo Finance (OHLCV) + NSE India (live)`);
  console.log(`  Options → NSE option-chain (PCR, max pain, OI)`);
  console.log(`  VIX     → India VIX (market regime)`);
  console.log(`  Score   → 7-factor weighted engine (100 pts)`);
  console.log(`  AI      → Groq ${GROQ_MODEL}\n`);
  if (!GROQ_KEY) {
    console.warn("  ⚠️  GROQ_API_KEY not set — get free key: https://console.groq.com");
    console.warn("  ⚠️  Run: GROQ_API_KEY=gsk_xxx node server.js\n");
  } else {
    console.log("  ✅ All systems ready\n");
  }
});
