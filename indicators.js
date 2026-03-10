/**
 * indicators.js — Pure Node.js technical indicator calculations
 * Input: array of candles [{ open, high, low, close, volume, date }]
 * All sorted oldest → newest
 */

// ── Simple helpers ────────────────────────────────────────────────────────────
function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

// ── SMA ───────────────────────────────────────────────────────────────────────
function sma(closes, period) {
  if (closes.length < period) return null;
  return mean(closes.slice(-period));
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = mean(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
  }
  return val;
}

function emaArray(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let val = mean(closes.slice(0, period));
  result.push(val);
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

// ── RSI ───────────────────────────────────────────────────────────────────────
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  let avgGain = mean(changes.slice(0, period).map(c => c > 0 ? c : 0));
  let avgLoss = mean(changes.slice(0, period).map(c => c < 0 ? -c : 0));
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? -changes[i] : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── MACD ──────────────────────────────────────────────────────────────────────
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const fastEMA = emaArray(closes, fast);
  const slowEMA = emaArray(closes, slow);
  // Align: fastEMA has more points, trim to match slowEMA length
  const diff = fast - slow; // negative
  const alignedFast = fastEMA.slice(-slowEMA.length);
  const macdLine = alignedFast.map((v, i) => v - slowEMA[i]);
  if (macdLine.length < signal) return null;
  const signalLine = emaArray(macdLine, signal);
  const lastMACD   = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return {
    macd:      +lastMACD.toFixed(4),
    signal:    +lastSignal.toFixed(4),
    histogram: +(lastMACD - lastSignal).toFixed(4),
    bullish:   lastMACD > lastSignal,
  };
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────
function bollingerBands(closes, period = 20, stdMult = 2) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const mid    = mean(slice);
  const std    = Math.sqrt(mean(slice.map(v => (v - mid) ** 2)));
  const upper  = mid + stdMult * std;
  const lower  = mid - stdMult * std;
  const last   = closes[closes.length - 1];
  const pctB   = std === 0 ? 0.5 : (last - lower) / (upper - lower);
  return {
    upper:  +upper.toFixed(2),
    mid:    +mid.toFixed(2),
    lower:  +lower.toFixed(2),
    pctB:   +pctB.toFixed(3),          // 0=at lower, 1=at upper
    width:  +((upper - lower) / mid * 100).toFixed(2), // band width %
    squeeze: ((upper - lower) / mid) < 0.04,           // tight bands
  };
}

// ── ATR (Average True Range) ──────────────────────────────────────────────────
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  // Simple average of last `period` TRs
  return mean(trs.slice(-period));
}

// ── Volume analysis ───────────────────────────────────────────────────────────
function volumeAnalysis(candles, period = 20) {
  if (candles.length < period) return null;
  const vols     = candles.map(c => c.volume);
  const avgVol   = mean(vols.slice(-period));
  const lastVol  = vols[vols.length - 1];
  const ratio    = lastVol / avgVol;
  // Delivery % is not available from Yahoo, so we approximate via price-volume correlation
  return {
    avgVolume:    Math.round(avgVol),
    lastVolume:   lastVol,
    ratio:        +ratio.toFixed(2),
    surge:        ratio > 1.5,
    dry:          ratio < 0.5,
    trending:     ratio > 1.2,
  };
}

// ── Trend strength ────────────────────────────────────────────────────────────
function trendAnalysis(closes) {
  const ema20  = ema(closes, 20);
  const ema50  = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const last   = closes[closes.length - 1];

  const aboveEma20  = last > ema20;
  const aboveEma50  = ema50  ? last > ema50  : null;
  const aboveEma200 = ema200 ? last > ema200 : null;
  const ema20AboveEma50 = (ema20 && ema50) ? ema20 > ema50 : null;

  let trend = "NEUTRAL";
  let score = 0;
  if (aboveEma20)  score++;
  if (aboveEma50)  score++;
  if (aboveEma200) score++;
  if (ema20AboveEma50) score++;
  if (score >= 3) trend = "BULLISH";
  else if (score <= 1) trend = "BEARISH";

  return { ema20, ema50, ema200, aboveEma20, aboveEma50, aboveEma200, trend, score };
}

// ── Support / Resistance (pivot-based) ───────────────────────────────────────
function supportResistance(candles) {
  // Use last 20 candles to find swing highs/lows
  const recent = candles.slice(-20);
  const highs  = recent.map(c => c.high);
  const lows   = recent.map(c => c.low);
  const last   = candles[candles.length - 1].close;

  // Pivot point
  const prevCandle = candles[candles.length - 2];
  const pivot = (prevCandle.high + prevCandle.low + prevCandle.close) / 3;
  const r1    = 2 * pivot - prevCandle.low;
  const s1    = 2 * pivot - prevCandle.high;
  const r2    = pivot + (prevCandle.high - prevCandle.low);
  const s2    = pivot - (prevCandle.high - prevCandle.low);

  // 52-week high/low
  const allHighs = candles.map(c => c.high);
  const allLows  = candles.map(c => c.low);
  const high52w  = Math.max(...allHighs);
  const low52w   = Math.min(...allLows);

  return {
    pivot:  +pivot.toFixed(2),
    r1:     +r1.toFixed(2),
    r2:     +r2.toFixed(2),
    s1:     +s1.toFixed(2),
    s2:     +s2.toFixed(2),
    high52w: +high52w.toFixed(2),
    low52w:  +low52w.toFixed(2),
    nearHigh52w: last > high52w * 0.95,
    nearLow52w:  last < low52w * 1.05,
  };
}

// ── 52-week position ──────────────────────────────────────────────────────────
function weekPosition(candles) {
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const last  = candles[candles.length - 1].close;
  const h52   = Math.max(...highs);
  const l52   = Math.min(...lows);
  const pct   = (last - l52) / (h52 - l52) * 100;
  return { high52w: +h52.toFixed(2), low52w: +l52.toFixed(2), positionPct: +pct.toFixed(1) };
}

// ── Master calculate function ─────────────────────────────────────────────────
function calculate(candles) {
  if (!candles || candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const last   = closes[closes.length - 1];
  const prev   = closes[closes.length - 2];
  const change = ((last - prev) / prev * 100);

  const rsiVal  = rsi(closes, 14);
  const macdVal = macd(closes);
  const bb      = bollingerBands(closes);
  const atrVal  = atr(candles);
  const vol     = volumeAnalysis(candles);
  const trend   = trendAnalysis(closes);
  const sr      = supportResistance(candles);
  const pos52w  = weekPosition(candles);

  // Overall momentum score (0–10)
  let momentum = 5;
  if (rsiVal)            { if (rsiVal > 60) momentum += 1; if (rsiVal < 40) momentum -= 1; }
  if (macdVal?.bullish)  momentum += 1; else if (macdVal) momentum -= 1;
  if (bb?.pctB > 0.6)    momentum += 1; else if (bb?.pctB < 0.3) momentum -= 1;
  if (vol?.surge)        momentum += 1;
  momentum = Math.min(10, Math.max(0, momentum));

  return {
    price: {
      last:    +last.toFixed(2),
      prev:    +prev.toFixed(2),
      change:  +change.toFixed(2),
      open:    +candles[candles.length - 1].open.toFixed(2),
      high:    +candles[candles.length - 1].high.toFixed(2),
      low:     +candles[candles.length - 1].low.toFixed(2),
    },
    rsi:        rsiVal ? +rsiVal.toFixed(2) : null,
    macd:       macdVal,
    bb,
    atr:        atrVal ? +atrVal.toFixed(2) : null,
    atrPct:     atrVal ? +(atrVal / last * 100).toFixed(2) : null,
    volume:     vol,
    trend,
    sr,
    pos52w,
    momentumScore: momentum,
    candleCount: candles.length,
  };
}

module.exports = { calculate, sma, ema, rsi, macd, bollingerBands, atr };
