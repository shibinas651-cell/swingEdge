/**
 * scoring.js — Multi-factor weighted swing trade scoring engine
 *
 * Combines:
 *  - Technical indicators (RSI, MACD, EMA, BB, ATR)
 *  - NSE market microstructure (delivery %, VWAP relation)
 *  - Options data (PCR, max pain distance)
 *  - India VIX (market regime filter)
 *  - Broad market trend (NIFTY context)
 *
 * Returns a score 0–100 with component breakdown and a CONFIDENCE level.
 */

function scoreStock({ indicators, nseData }) {
  const scores   = {};
  const reasons  = [];
  const warnings = [];

  const ind = indicators || {};
  const quote = nseData?.quote || {};
  const oc    = nseData?.optionChain || {};
  const vix   = nseData?.vix || {};
  const nifty = nseData?.niftyContext || {};

  // ── 1. TREND (20 pts) ───────────────────────────────────────────────────────
  let trend = 0;
  const t = ind.trend || {};
  if (t.aboveEma20)   trend += 5;
  if (t.aboveEma50)   trend += 7;
  if (t.aboveEma200)  trend += 8;
  // EMA alignment bonus
  if (t.aboveEma20 && t.aboveEma50 && t.aboveEma200) { trend = 20; reasons.push("Strong uptrend — price above EMA20/50/200"); }
  else if (!t.aboveEma20 && !t.aboveEma50 && !t.aboveEma200) { trend = 0; warnings.push("Downtrend — price below all EMAs"); }
  scores.trend = Math.min(20, trend);

  // ── 2. MOMENTUM (20 pts) ────────────────────────────────────────────────────
  let momentum = 10; // neutral base
  const rsi = ind.rsi;
  const macd = ind.macd;

  if (rsi != null) {
    if (rsi >= 55 && rsi <= 70)      { momentum += 6; reasons.push(`RSI ${rsi} — bullish momentum zone`); }
    else if (rsi > 70)               { momentum -= 4; warnings.push(`RSI ${rsi} — overbought, risk of pullback`); }
    else if (rsi < 40 && rsi >= 30)  { momentum -= 2; reasons.push(`RSI ${rsi} — approaching oversold, watch for reversal`); }
    else if (rsi < 30)               { momentum += 3; reasons.push(`RSI ${rsi} — oversold, potential bounce`); }
    else if (rsi >= 45 && rsi < 55)  { momentum += 2; }
  }
  if (macd?.bullish) { momentum += 4; reasons.push("MACD bullish crossover"); }
  else if (macd)     { momentum -= 3; warnings.push("MACD bearish crossover"); }
  scores.momentum = Math.min(20, Math.max(0, momentum));

  // ── 3. VOLATILITY / ATR (15 pts) ────────────────────────────────────────────
  let vol = 8;
  const atrPct = ind.atrPct;
  if (atrPct != null) {
    if (atrPct >= 1.5 && atrPct <= 4) { vol = 15; reasons.push(`ATR ${atrPct}% — ideal swing volatility`); }
    else if (atrPct > 4)              { vol = 8;  warnings.push(`ATR ${atrPct}% — very high volatility, wide stop loss needed`); }
    else if (atrPct < 1)              { vol = 3;  warnings.push(`ATR ${atrPct}% — low volatility, slow-moving stock`); }
    else                              { vol = 10; }
  }
  // Bollinger squeeze = incoming move
  if (ind.bb?.squeeze) { vol = Math.min(15, vol + 3); reasons.push("Bollinger Squeeze detected — breakout imminent"); }
  scores.volatility = vol;

  // ── 4. VOLUME (10 pts) ──────────────────────────────────────────────────────
  let volumeScore = 5;
  const volRatio = ind.volume?.ratio;
  if (volRatio != null) {
    if (volRatio >= 1.5)       { volumeScore = 10; reasons.push(`Volume ${volRatio}x avg — strong institutional interest`); }
    else if (volRatio >= 1.0)  { volumeScore = 7; }
    else if (volRatio < 0.5)   { volumeScore = 2; warnings.push("Volume below average — weak conviction"); }
  }
  scores.volume = volumeScore;

  // ── 5. NSE DELIVERY % (15 pts — most important Indian signal) ───────────────
  let delivery = 7; // neutral when unavailable
  const delPct = quote.deliveryPct;
  if (delPct != null) {
    if (delPct >= 50)        { delivery = 15; reasons.push(`Delivery ${delPct}% — strong conviction buying`); }
    else if (delPct >= 35)   { delivery = 10; reasons.push(`Delivery ${delPct}% — reasonable delivery`); }
    else if (delPct >= 20)   { delivery = 6; }
    else                     { delivery = 2; warnings.push(`Delivery ${delPct}% — mostly speculative trades`); }
  }
  scores.delivery = delivery;

  // ── 6. OPTION CHAIN PCR (10 pts) ────────────────────────────────────────────
  let pcrScore = 5;
  if (oc.pcr != null) {
    const pcr = oc.pcr;
    if (pcr >= 1.2 && pcr <= 2.0)   { pcrScore = 10; reasons.push(`PCR ${pcr} — bullish sentiment (put heavy)`); }
    else if (pcr >= 0.8)             { pcrScore = 6;  }
    else if (pcr < 0.5)              { pcrScore = 2;  warnings.push(`PCR ${pcr} — bearish sentiment (call heavy)`); }
    // Max pain proximity
    if (oc.maxPainStrike && ind.price?.last) {
      const dist = Math.abs(ind.price.last - oc.maxPainStrike) / ind.price.last * 100;
      if (dist < 2) reasons.push(`Price near Max Pain ₹${oc.maxPainStrike} — expiry magnet`);
    }
  }
  scores.optionChain = pcrScore;

  // ── 7. INDIA VIX REGIME FILTER (10 pts) ─────────────────────────────────────
  let vixScore = 5;
  if (vix.value != null) {
    const v = parseFloat(vix.value);
    if (v < 12)       { vixScore = 7; warnings.push(`VIX ${v} — very low, market complacent`); }
    else if (v < 16)  { vixScore = 10; reasons.push(`VIX ${v} — ideal range for swing trades`); }
    else if (v < 20)  { vixScore = 7; }
    else if (v < 25)  { vixScore = 4; warnings.push(`VIX ${v} — elevated, use tighter stops`); }
    else              { vixScore = 0; warnings.push(`VIX ${v} — HIGH, avoid swing trades!`); }
  }
  scores.vix = vixScore;

  // ── Total ────────────────────────────────────────────────────────────────────
  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  const maxPossible = 20 + 20 + 15 + 10 + 15 + 10 + 10; // = 100
  const normalised  = Math.round((total / maxPossible) * 100);

  // ── Verdict ──────────────────────────────────────────────────────────────────
  let verdict = "NEUTRAL";
  if (normalised >= 68)      verdict = "GOOD";
  else if (normalised <= 38) verdict = "AVOID";

  // Hard overrides
  if (vix.value > 25)                         { verdict = "AVOID"; warnings.push("VIX override: market too volatile"); }
  if (!t.aboveEma50 && !t.aboveEma20)         { verdict = verdict === "GOOD" ? "NEUTRAL" : verdict; }
  if (quote.deliveryPct != null && quote.deliveryPct < 15 && normalised < 60) verdict = "AVOID";

  // Confidence based on how many data sources returned data
  let dataSources = 0;
  if (ind.rsi)           dataSources++;
  if (ind.macd)          dataSources++;
  if (quote.deliveryPct) dataSources++;
  if (oc.pcr)            dataSources++;
  if (vix.value)         dataSources++;
  const confidence = dataSources >= 4 ? "HIGH" : dataSources >= 2 ? "MEDIUM" : "LOW";

  // Swing score on 10 scale for UI
  const score10 = Math.round(normalised / 10);

  return {
    verdict,
    score10:      Math.min(10, Math.max(1, score10)),
    score100:     normalised,
    confidence,
    scores,       // component breakdown
    reasons:      reasons.slice(0, 5),
    warnings:     warnings.slice(0, 4),
    dataSources,
  };
}

module.exports = { scoreStock };
