// Advisor engine: rating, position sizing, brokerage across platforms.
// Pure functions, no DOM. Works in the browser (window.AdvisorEngine) and Node (module.exports).
// Educational tool only. Not investment advice.

(function (root) {
  'use strict';

  // ---------- indicators ----------
  const sma = (a, n) => (a.length < n ? null : a.slice(-n).reduce((s, x) => s + x, 0) / n);

  function emaSeries(a, n) {
    const k = 2 / (n + 1), out = [];
    let prev = a[0];
    for (let i = 0; i < a.length; i++) { prev = i === 0 ? a[0] : a[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  }

  function rsi(closes, n = 14) {
    if (closes.length <= n) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? (g += d) : (l -= d); }
    g /= n; l /= n;
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  function macdHist(closes) {
    if (closes.length < 35) return null;
    const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
    const line = e12.map((v, i) => v - e26[i]);
    const sig = emaSeries(line, 9);
    return line[line.length - 1] - sig[sig.length - 1];
  }

  function atr(candles, n = 14) {
    if (candles.length <= n) return null;
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], pc = candles[i - 1].close;
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
    }
    let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
    for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
    return a;
  }

  function annVol(closes) {
    const r = [];
    for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
    if (r.length < 20) return null;
    const m = r.reduce((s, x) => s + x, 0) / r.length;
    const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
    return Math.sqrt(v * 252);
  }

  // ---------- rating ----------
  // Score in [-100, 100] built from transparent rules; every rule is reported back.
  function rate(candles, sentiment) {
    const closes = candles.map((c) => c.close);
    const px = closes[closes.length - 1];
    const s50 = sma(closes, 50), s200 = sma(closes, 200);
    const r = rsi(closes), mh = macdHist(closes), vol = annVol(closes);
    const hi = Math.max(...closes.slice(-252)), lo = Math.min(...closes.slice(-252));
    const ret63 = closes.length > 63 ? px / closes[closes.length - 64] - 1 : null;
    const rules = [];
    const add = (pts, label) => rules.push({ pts, label });

    if (s200 != null) add(px > s200 ? 20 : -20, `Price ${px > s200 ? 'above' : 'below'} 200-day average (long-term trend)`);
    else if (s50 != null) add(px > s50 ? 10 : -10, `Price ${px > s50 ? 'above' : 'below'} 50-day average (under 200 days of data)`);
    if (s50 != null && s200 != null) add(s50 > s200 ? 15 : -15, s50 > s200 ? 'Golden-cross structure (50d > 200d)' : 'Death-cross structure (50d < 200d)');
    if (ret63 != null) {
      if (ret63 > 0.05) add(10, `3-month momentum +${(ret63 * 100).toFixed(1)}%`);
      else if (ret63 < -0.05) add(-10, `3-month momentum ${(ret63 * 100).toFixed(1)}%`);
      else add(0, `3-month momentum flat (${(ret63 * 100).toFixed(1)}%)`);
    }
    if (r != null) {
      if (r < 30) add(20, `RSI ${r.toFixed(0)}: oversold`);
      else if (r < 45) add(5, `RSI ${r.toFixed(0)}: cooling, room to run`);
      else if (r > 70) add(-20, `RSI ${r.toFixed(0)}: overbought`);
      else add(0, `RSI ${r.toFixed(0)}: neutral`);
    }
    if (mh != null) add(mh > 0 ? 10 : -10, `MACD histogram ${mh > 0 ? 'positive (bullish)' : 'negative (bearish)'}`);
    const dd = hi ? px / hi - 1 : 0;
    if (dd < -0.3 && s200 != null && px < s200) add(-10, `${(dd * 100).toFixed(0)}% off 52-week high and still in downtrend`);
    if (vol != null && vol > 0.6) add(-10, `High volatility (${(vol * 100).toFixed(0)}% annualised)`);

    if (sentiment) add(sentiment.pts, `News and results tone: ${sentiment.label} (${sentiment.scored.length} recent headlines)`);
    const score = Math.max(-100, Math.min(100, rules.reduce((s, x) => s + x.pts, 0)));
    const rating = score >= 45 ? 'STRONG BUY' : score >= 15 ? 'BUY' : score > -15 ? 'HOLD' : score > -45 ? 'SELL' : 'STRONG SELL';
    return { rating, score, rules, px, sma50: s50, sma200: s200, rsi: r, macdHist: mh, atr: atr(candles), vol, high52: hi, low52: lo };
  }


  // ---------- news / results sentiment ----------
  // Simple keyword scoring of headlines. Crude by design: it flags the tone, it does not read the article.
  const POS = ['beat','beats','surge','surges','jump','jumps','soar','record','profit rises','profit up','growth','upgrade','upgraded','outperform','strong','rally','gains','raises guidance','buyback','dividend','order win','wins order','expands','approval','bullish','higher'];
  const NEG = ['miss','misses','plunge','plunges','falls','fall','drop','drops','slump','loss','losses','downgrade','downgraded','underperform','weak','probe','fraud','penalty','fine','lawsuit','cuts guidance','layoff','layoffs','default','bearish','lower','decline','declines','resign','raid','sebi notice'];
  function headlineScore(t) {
    const x = ' ' + String(t).toLowerCase() + ' ';
    let s = 0;
    POS.forEach((w) => { if (x.includes(' ' + w)) s++; });
    NEG.forEach((w) => { if (x.includes(' ' + w)) s--; });
    return s;
  }
  function newsSentiment(items) {
    if (!items || !items.length) return null;
    const scored = items.map((it) => ({ ...it, score: headlineScore(it.title) }));
    const net = scored.reduce((a, b) => a + Math.sign(b.score), 0);
    const ratio = net / scored.length;
    const label = ratio > 0.2 ? 'Positive' : ratio < -0.2 ? 'Negative' : 'Mixed / neutral';
    const pts = ratio > 0.2 ? 10 : ratio < -0.2 ? -10 : 0;
    return { label, ratio, pts, scored };
  }

  // ---------- position sizing ----------
  // Risk-based: lose at most riskPct of capital if the ATR stop is hit,
  // and never put more than maxPosPct of capital in one stock.
  function size({ price, atrVal, capital, riskPct = 1, maxPosPct = 20, atrMult = 2, rewardR = 2, rating }) {
    const stopDist = atrVal ? atrVal * atrMult : price * 0.08; // fallback 8% stop with no ATR
    const stop = Math.max(price - stopDist, 0.01);
    const target = price + stopDist * rewardR;
    const riskBudget = capital * (riskPct / 100);
    const byRisk = Math.floor(riskBudget / stopDist);
    const byCap = Math.floor((capital * (maxPosPct / 100)) / price);
    const bearish = rating === 'SELL' || rating === 'STRONG SELL';
    const scale = rating === 'STRONG BUY' ? 1 : rating === 'BUY' ? 0.75 : rating === 'HOLD' ? 0.4 : 0;
    const qty = bearish ? 0 : Math.max(0, Math.floor(Math.min(byRisk, byCap) * scale));
    return {
      qty, stop, target, stopDist, riskBudget, byRisk, byCap, scale,
      invest: qty * price, maxLoss: qty * stopDist, potentialGain: qty * stopDist * rewardR,
      binding: byRisk <= byCap ? 'risk per trade' : 'max position size'
    };
  }

  // ---------- brokerage ----------
  // Rates as published on broker pricing pages; verified Nov 2026. Edit here when they change.
  const pct = (p) => (v) => v * p / 100;
  const lower = (flat, p, min = 0) => (v) => Math.max(Math.min(flat, (v * p) / 100), Math.min(min, flat));

  const INDIA = [
    { name: 'Zerodha',       delivery: () => 0,             intraday: lower(20, 0.03),  dp: 15.34, amc: '₹300/yr (BSDA lower)' },
    { name: 'Dhan',          delivery: () => 0,             intraday: lower(20, 0.03),  dp: 12.5,  amc: '₹0' },
    { name: 'Groww',         delivery: lower(20, 0.1, 5),   intraday: lower(20, 0.1, 5), dp: 20,    amc: '₹0' },
    { name: 'Angel One',     delivery: lower(20, 0.1, 5),   intraday: lower(20, 0.03),  dp: 20,    amc: '₹0 yr 1, then ₹240/yr' },
    { name: 'Upstox',        delivery: lower(20, 2.5),      intraday: lower(20, 0.05),  dp: 18.5,  amc: '₹0' },
    { name: '5paisa',        delivery: () => 20,            intraday: () => 20,          dp: 12.5,  amc: '₹0' },
    { name: 'Kotak Neo',     delivery: pct(0.2),            intraday: () => 10,          dp: 20,    amc: 'varies by plan' },
    { name: 'ICICI Direct',  delivery: pct(0.29),           intraday: pct(0.029),        dp: 20,    amc: '₹700/yr' },
    { name: 'HDFC Securities', delivery: pct(0.5),          intraday: pct(0.05),         dp: 20,    amc: '₹750/yr' }
  ];

  // NSE statutory charges. Delivery STT 0.1% both sides; intraday STT 0.025% on sell.
  function indiaCharges(b, buyVal, sellVal, segment) {
    const deliv = segment === 'delivery';
    const brok = deliv ? b.delivery(buyVal) + b.delivery(sellVal) : b.intraday(buyVal) + b.intraday(sellVal);
    const turnover = buyVal + sellVal;
    const stt = deliv ? 0.001 * turnover : 0.00025 * sellVal;
    const txn = 0.0000297 * turnover;
    const sebi = 0.000001 * turnover; // ₹10 per crore
    const stamp = deliv ? 0.00015 * buyVal : 0.00003 * buyVal;
    const gst = 0.18 * (brok + txn + sebi);
    const dp = deliv ? b.dp * 1.18 : 0;
    const total = brok + stt + txn + sebi + stamp + gst + dp;
    return { broker: b.name, brokerage: brok, stt, txn, sebi, stamp, gst, dp, total, amc: b.amc };
  }

  const US = [
    { name: 'Robinhood',        comm: () => 0 },
    { name: 'Charles Schwab',   comm: () => 0 },
    { name: 'Fidelity',         comm: () => 0 },
    { name: 'Webull',           comm: () => 0 },
    { name: 'IBKR Lite',        comm: () => 0 },
    { name: 'IBKR Pro (fixed)', comm: (q, v) => Math.min(Math.max(1, 0.005 * q), 0.01 * v) }
  ];

  // SEC Section 31 fee: $20.60 per $1M of sales (from 4 Apr 2026). FINRA TAF on shares sold (approx, capped).
  function usCharges(b, qty, buyVal, sellVal) {
    const comm = qty ? b.comm(qty, buyVal) + b.comm(qty, sellVal) : 0;
    const sec = sellVal * 20.6 / 1e6;
    const taf = Math.min(qty * 0.000195, 9.79);
    return { broker: b.name, brokerage: comm, sec, taf, total: comm + sec + taf };
  }

  function brokerage({ market, qty, buyPrice, sellPrice, segment = 'delivery' }) {
    const buyVal = qty * buyPrice, sellVal = qty * sellPrice;
    const rows = market === 'IN'
      ? INDIA.map((b) => indiaCharges(b, buyVal, sellVal, segment))
      : US.map((b) => usCharges(b, qty, buyVal, sellVal));
    rows.forEach((r) => {
      r.netPnl = sellVal - buyVal - r.total;
      r.breakeven = qty ? r.total / qty : 0;
    });
    return rows.sort((a, b) => a.total - b.total);
  }

  const api = { newsSentiment, headlineScore, sma, rsi, macdHist, atr, annVol, rate, size, brokerage, INDIA, US };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdvisorEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
