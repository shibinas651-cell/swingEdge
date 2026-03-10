/**
 * nseData.js — Fetch enriched Indian market data from NSE directly
 * Endpoints used (all free, no API key):
 *   - /api/quote-equity       → delivery%, trade info, VWAP, circuit limits
 *   - /api/option-chain-equities → PCR, max pain, OI buildup
 *   - Yahoo Finance ^INDIAVIX → India VIX
 *   - /api/corporates-announcements → upcoming events/results
 *   - /api/market-status      → market open/close state
 *
 * NSE requires a session cookie obtained by visiting the homepage first.
 */

const https = require("https");

const NSE_BASE   = "www.nseindia.com";
const NSE_UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const NSE_ACCEPT = "application/json, text/plain, */*";

let _sessionCookie = "";
let _cookieTs      = 0;
const COOKIE_TTL   = 10 * 60 * 1000; // refresh every 10 min

// ── Get/refresh NSE session cookie ───────────────────────────────────────────
async function getNSECookie() {
  if (_sessionCookie && Date.now() - _cookieTs < COOKIE_TTL) return _sessionCookie;
  return new Promise(resolve => {
    const opts = {
      hostname: NSE_BASE,
      path:     "/",
      method:   "GET",
      headers: {
        "User-Agent":      NSE_UA,
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection":      "keep-alive",
      },
    };
    const req = https.request(opts, res => {
      const cookies = res.headers["set-cookie"] || [];
      _sessionCookie = cookies.map(c => c.split(";")[0]).join("; ");
      _cookieTs = Date.now();
      resolve(_sessionCookie);
    });
    req.on("error", () => resolve(""));
    req.setTimeout(8000, () => { req.destroy(); resolve(""); });
    req.end();
  });
}

// ── NSE GET helper ────────────────────────────────────────────────────────────
function nseGet(apiPath) {
  return new Promise(async (resolve, reject) => {
    const cookie = await getNSECookie();
    const opts = {
      hostname: NSE_BASE,
      path:     apiPath,
      method:   "GET",
      headers: {
        "User-Agent":   NSE_UA,
        "Accept":       NSE_ACCEPT,
        "Referer":      "https://www.nseindia.com/",
        "Cookie":       cookie,
        "Connection":   "keep-alive",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try   { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ ok: false, status: res.statusCode, data: null, raw: body.slice(0, 200) }); }
      });
    });
    req.on("error", e => resolve({ ok: false, data: null, err: e.message }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ ok: false, data: null, err: "timeout" }); });
    req.end();
  });
}

// ── Yahoo Finance HTTPS get (reuse from marketData pattern) ──────────────────
function yahooGet(path) {
  return new Promise((resolve) => {
    const opts = {
      hostname: "query1.finance.yahoo.com",
      path,
      method: "GET",
      headers: { "User-Agent": NSE_UA },
    };
    const req = https.request(opts, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── 1. Equity Quote + Delivery % ─────────────────────────────────────────────
async function fetchNSEQuote(symbol) {
  const r = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(symbol.toUpperCase())}`);
  if (!r.ok || !r.data) return null;
  const d = r.data;
  const info  = d.info  || {};
  const trade = d.priceInfo || {};
  const sec   = d.securityInfo || {};
  const pre   = d.preOpenMarket || {};

  return {
    symbol:          info.symbol,
    companyName:     info.companyName,
    industry:        info.industry,
    sector:          info.sector,
    isFNO:           info.isFNOSec,
    isIndex:         info.isIndex,
    lastPrice:       trade.lastPrice,
    change:          trade.change,
    pChange:         trade.pChange,
    open:            trade.open,
    high:            trade.intraDayHighLow?.max,
    low:             trade.intraDayHighLow?.min,
    previousClose:   trade.previousClose,
    vwap:            trade.vwap,
    weekHigh52:      trade.weekHighLow?.max,
    weekLow52:       trade.weekHighLow?.min,
    upperCircuit:    sec.upperCP,
    lowerCircuit:    sec.lowerCP,
    deliveryPct:     sec.deliveryToTradedQty,
    deliveryQty:     sec.totalTradedVolume ? Math.round((sec.deliveryToTradedQty / 100) * sec.totalTradedVolume) : null,
    totalVolume:     sec.totalTradedVolume,
    totalTurnover:   sec.totalTurnover,
    marketCap:       d.marketDeptOrderBook?.tradeInfo?.totalTradedValue,
    faceValue:       sec.faceValue,
    pe:              d.metadata?.pdSymbolPe,
    pb:              d.metadata?.pdPriceBand,
    series:          info.series,
    isin:            info.isin,
    listingDate:     info.listingDate,
    preOpenIep:      pre.IEP,
    preOpenChange:   pre.perChange,
  };
}

// ── 2. Option Chain → PCR, Max Pain, OI analysis ─────────────────────────────
async function fetchOptionChain(symbol) {
  const isIndex  = ["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX"].includes(symbol.toUpperCase());
  const endpoint = isIndex
    ? `/api/option-chain-indices?symbol=${encodeURIComponent(symbol.toUpperCase())}`
    : `/api/option-chain-equities?symbol=${encodeURIComponent(symbol.toUpperCase())}`;

  const r = await nseGet(endpoint);
  if (!r.ok || !r.data?.records?.data) return null;

  const records  = r.data.records.data;
  const spotPrice = r.data.records.underlyingValue || 0;
  const expiries  = r.data.records.expiryDates || [];
  const nearExpiry = expiries[0];

  // Filter to nearest expiry
  const nearData = records.filter(d => d.expiryDate === nearExpiry);

  let totalCallOI = 0, totalPutOI = 0;
  let totalCallVol = 0, totalPutVol = 0;
  let maxPainStrike = 0, minPain = Infinity;
  const oiByStrike = {};

  nearData.forEach(({ strikePrice, CE, PE }) => {
    const ceOI = CE?.openInterest || 0;
    const peOI = PE?.openInterest || 0;
    totalCallOI  += ceOI;
    totalPutOI   += peOI;
    totalCallVol += (CE?.totalTradedVolume || 0);
    totalPutVol  += (PE?.totalTradedVolume || 0);
    oiByStrike[strikePrice] = { ce: ceOI, pe: peOI };
  });

  // Max pain: strike where total OI loss to buyers is maximum (i.e., minimum)
  Object.keys(oiByStrike).forEach(strike => {
    const s = parseFloat(strike);
    let pain = 0;
    Object.keys(oiByStrike).forEach(k => {
      const ks = parseFloat(k);
      pain += oiByStrike[k].ce * Math.max(0, ks - s);
      pain += oiByStrike[k].pe * Math.max(0, s - ks);
    });
    if (pain < minPain) { minPain = pain; maxPainStrike = s; }
  });

  const pcr = totalPutOI / (totalCallOI || 1);

  // Identify max OI call (resistance) and max OI put (support)
  let maxCallStrike = 0, maxCallOI = 0;
  let maxPutStrike  = 0, maxPutOI  = 0;
  Object.keys(oiByStrike).forEach(strike => {
    const s = parseFloat(strike);
    if (oiByStrike[strike].ce > maxCallOI) { maxCallOI = oiByStrike[strike].ce; maxCallStrike = s; }
    if (oiByStrike[strike].pe > maxPutOI)  { maxPutOI  = oiByStrike[strike].pe; maxPutStrike  = s; }
  });

  return {
    nearExpiry,
    spotPrice,
    totalCallOI,
    totalPutOI,
    totalCallVol,
    totalPutVol,
    pcr:            +pcr.toFixed(3),
    pcrSentiment:   pcr > 1.5 ? "VERY BULLISH" : pcr > 1.0 ? "BULLISH" : pcr > 0.7 ? "NEUTRAL" : pcr > 0.5 ? "BEARISH" : "VERY BEARISH",
    maxPainStrike,
    maxCallOI_strike: maxCallStrike,  // strongest resistance
    maxPutOI_strike:  maxPutStrike,   // strongest support
    isIndex,
  };
}

// ── 3. India VIX ──────────────────────────────────────────────────────────────
async function fetchIndiaVIX() {
  // Try NSE first
  const r = await nseGet("/api/allIndices");
  if (r.ok && r.data?.data) {
    const vix = r.data.data.find(i => i.index === "India VIX" || i.indexSymbol === "INDIAVIX");
    if (vix) return {
      value:   vix.last || vix.indexValue,
      change:  vix.percentChange || vix.variation,
      high:    vix.high,
      low:     vix.low,
      signal:  interpretVIX(vix.last || vix.indexValue),
    };
  }
  // Fallback: Yahoo Finance
  const ydata = await yahooGet("/v8/finance/chart/%5EINDIAVIX?interval=1d&range=5d");
  const price = ydata?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (price) return { value: price, signal: interpretVIX(price) };
  return null;
}

function interpretVIX(vix) {
  if (!vix) return "UNKNOWN";
  if (vix < 12)  return "VERY LOW — low fear, bullish but complacent";
  if (vix < 16)  return "LOW — calm market, good for swing trades";
  if (vix < 20)  return "MODERATE — normal, swing trades viable";
  if (vix < 25)  return "ELEVATED — increased risk, use tight stop loss";
  return                 "HIGH — avoid swing trades, market unstable";
}

// ── 4. Corporate Events / Results Calendar ────────────────────────────────────
async function fetchCorporateEvents(symbol) {
  const r = await nseGet(`/api/corporates-announcements?index=equities&symbol=${encodeURIComponent(symbol.toUpperCase())}&issuer=&from_date=&to_date=`);
  if (!r.ok || !r.data) return [];
  const items = Array.isArray(r.data) ? r.data : (r.data.data || []);
  return items.slice(0, 5).map(e => ({
    subject:  e.subject || e.desc,
    date:     e.an_dt  || e.bm_date || e.date,
    type:     e.attchmntType || "Announcement",
  }));
}

// ── 5. Market Status ──────────────────────────────────────────────────────────
async function fetchMarketStatus() {
  const r = await nseGet("/api/market-status");
  if (!r.ok || !r.data?.marketState) return { isOpen: null };
  const equity = r.data.marketState.find(m => m.market === "Capital Market" || m.marketId === "CM");
  return {
    isOpen:     equity?.marketStatus === "Open",
    status:     equity?.marketStatus,
    tradeDate:  equity?.tradeDate,
  };
}

// ── 6. NIFTY 50 trend (broad market context) ──────────────────────────────────
async function fetchNiftyContext() {
  const r = await nseGet("/api/allIndices");
  if (!r.ok || !r.data?.data) return null;
  const nifty = r.data.data.find(i => i.indexSymbol === "NIFTY 50" || i.index === "NIFTY 50");
  if (!nifty) return null;
  return {
    value:   nifty.last || nifty.indexValue,
    change:  nifty.percentChange || nifty.variation,
    trend:   (nifty.percentChange || 0) >= 0 ? "POSITIVE" : "NEGATIVE",
    yearHigh: nifty.yearHigh,
    yearLow:  nifty.yearLow,
  };
}

// ── Master fetch — all NSE data in parallel ───────────────────────────────────
async function fetchAllNSEData(symbol) {
  const [quote, optChain, vix, events, mktStatus, nifty] = await Promise.allSettled([
    fetchNSEQuote(symbol),
    fetchOptionChain(symbol),
    fetchIndiaVIX(),
    fetchCorporateEvents(symbol),
    fetchMarketStatus(),
    fetchNiftyContext(),
  ]);

  return {
    quote:       quote.value       || null,
    optionChain: optChain.value    || null,
    vix:         vix.value         || null,
    events:      events.value      || [],
    marketStatus: mktStatus.value  || null,
    niftyContext: nifty.value      || null,
  };
}

module.exports = { fetchAllNSEData, fetchNSEQuote, fetchOptionChain, fetchIndiaVIX, interpretVIX };
