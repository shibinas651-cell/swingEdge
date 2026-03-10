/**
 * marketData.js — Fetch real OHLCV data from Yahoo Finance
 * NSE stocks use suffix .NS  (e.g. RELIANCE.NS)
 * BSE stocks use suffix .BO  (e.g. RELIANCE.BO)
 * No API key required.
 */

const https = require("https");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Raw HTTPS GET ─────────────────────────────────────────────────────────────
function httpsGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   "GET",
      headers:  { "User-Agent": USER_AGENT, ...headers },
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end",  () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Yahoo Finance request timed out")); });
    req.end();
  });
}

// ── Fetch historical OHLCV (1 year of daily candles) ─────────────────────────
async function fetchHistorical(symbol) {
  const ySymbol = toYahooSymbol(symbol);
  const end   = Math.floor(Date.now() / 1000);
  const start = end - 365 * 24 * 3600; // 1 year back

  const urlStr = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?interval=1d&period1=${start}&period2=${end}&events=history`;

  const { status, body } = await httpsGet(urlStr);

  if (status !== 200) {
    throw new Error(`Yahoo Finance returned HTTP ${status} for ${ySymbol}`);
  }

  let json;
  try { json = JSON.parse(body); } catch { throw new Error("Yahoo Finance returned invalid JSON"); }

  const result = json?.chart?.result?.[0];
  if (!result) {
    const errMsg = json?.chart?.error?.description || "No data found";
    throw new Error(`Yahoo Finance: ${errMsg} (symbol: ${ySymbol})`);
  }

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const { open = [], high = [], low = [], close = [], volume = [] } = q;

  if (close.length === 0) throw new Error(`No price data returned for ${ySymbol}`);

  // Build candle array, filtering nulls
  const candles = timestamps
    .map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().split("T")[0],
      open:   open[i],
      high:   high[i],
      low:    low[i],
      close:  close[i],
      volume: volume[i] || 0,
    }))
    .filter(c => c.close != null && c.open != null && c.high != null && c.low != null);

  // Meta info
  const meta = result.meta || {};

  return {
    symbol:        ySymbol,
    originalInput: symbol.toUpperCase(),
    currency:      meta.currency || "INR",
    exchangeName:  meta.exchangeName || "NSE",
    fullName:      meta.longName || meta.shortName || symbol.toUpperCase(),
    regularMarketPrice: meta.regularMarketPrice || candles[candles.length - 1]?.close,
    fiftyTwoWeekHigh:   meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow:    meta.fiftyTwoWeekLow,
    candles,
  };
}

// ── Fetch quote (current price + basic info) ──────────────────────────────────
async function fetchQuote(symbol) {
  const ySymbol = toYahooSymbol(symbol);
  const urlStr  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ySymbol)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,sector,industry,exchange`;

  const { status, body } = await httpsGet(urlStr);
  if (status !== 200) return null;

  try {
    const json   = JSON.parse(body);
    const result = json?.quoteResponse?.result?.[0];
    return result || null;
  } catch { return null; }
}

// ── Determine Yahoo Finance symbol ───────────────────────────────────────────
function toYahooSymbol(input) {
  const s = input.toUpperCase().trim();
  // Already has suffix
  if (s.endsWith(".NS") || s.endsWith(".BO")) return s;
  // Default to NSE
  return s + ".NS";
}

// ── Format large numbers (crores/lakhs) ──────────────────────────────────────
function formatINR(val) {
  if (!val) return "N/A";
  if (val >= 1e12) return "₹" + (val / 1e12).toFixed(2) + "L Cr";
  if (val >= 1e7)  return "₹" + (val / 1e7).toFixed(2) + " Cr";
  return "₹" + val.toLocaleString("en-IN");
}

module.exports = { fetchHistorical, fetchQuote, toYahooSymbol, formatINR };
