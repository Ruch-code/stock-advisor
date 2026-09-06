// Netlify Function: proxy chart/quote data server-side.
// Strategy (layered so the static site always gets candles without exposing keys):
//   USD / US stocks : Finnhub      (free key via FINNHUB_API_KEY env var)
//   INR / NSE/BSE   : Twelve Data  (free key via TWELVEDATA_API_KEY env var)
//   Fallback        : Yahoo Finance crumb+session (best effort; often 429s dc IPs)
// Why a function at all: Yahoo/TerminalFeed block plain browser CORS requests.

const YAHOO_HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
const FINNHUB = 'https://finnhub.io/api/v1/stock/candle';
const TWELVE = 'https://api.twelvedata.com/time_series';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const ALLOWED_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1h', '1d', '1wk', '1mo']);

const RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730, '5y': 1825, 'max': 9130 };

const NEWS_FEEDS = {
  markets: [
    { src: 'google:stock market today',               name: 'Google News' },
    { src: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', name: 'Economic Times' }
  ],
  india: [
    { src: 'google:nifty sensex stock market', name: 'Google News India', locale: 'in' },
    { src: 'google:india stock market',        name: 'Google News India', locale: 'in' },
    { src: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', name: 'Economic Times' },
    { src: 'https://www.moneycontrol.com/rss/latestnews.xml',            name: 'Moneycontrol' }
  ],
  ideas: [
    { src: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', name: 'MarketWatch' },
    { src: 'https://www.investing.com/rss/news_25.rss',                  name: 'Investing.com' }
  ],
  gold: [
    { src: 'google:gold price',                        name: 'Google News' },
    { src: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', name: 'Economic Times' },
    { src: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',       name: 'CNBC' }
  ],
  wallst: [
    { src: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',       name: 'CNBC' },
    { src: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',  name: 'MarketWatch' }
  ]
};
const NEWS_CURATED = {
  markets: ['Fed signals rate path stability as inflation cools', 'Nifty holds support; FII flows turn positive', 'Big tech earnings beat estimates, AI capex continues'],
  india: ['Nifty, Sensex open higher as IT and banking lead', 'RBI in focus: inflation, liquidity and rate path', 'Rupee steadies as dollar index eases', 'FII flows turn positive into Indian equities'],
  ideas: ['Semiconductor orders rebound ahead of holidays', 'Banks screen attractive as credit growth picks up', 'Quality compounders on SIP-watch after the pullback'],
  gold: ['Gold nears record high as geopolitical risks persist', 'Oil prices steady as global demand outlook improves', 'Treasury yields drift lower on soft jobs data'],
  wallst: ['Wall Street weighs earnings vs macro data', 'S&P 500 holds range as yields ease', 'Nasdaq leads on AI-driver momentum']
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Server-side response cache (per warm instance) so alert polling every 20s doesn't
// hammer free-tier providers; 60s TTL is plenty for quotes.
const serverCache = new Map();
function cached(key) {
  const e = serverCache.get(key);
  if (e && e.t > Date.now() - 60000) return e.v;
  return null;
}
function cacheSet(key, val) {
  serverCache.set(key, { v: val, t: Date.now() });
}

const isIndia = (s) => /\.(NS|BO)$/i.test(s);
const indiaBase = (s) => s.replace(/\.(NS|BO)$/i, '');
const indiaExchange = (s) => (/\.BO$/i.test(s) ? 'BSE' : 'NSE');

const landmark = (obj) => ({
  chart: {
    result: [obj],
    error: null
  }
});

async function finnhubChart(symbol, interval, range) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  const days = RANGE_DAYS[range] || 5;
  const extra = interval === '1d' ? 0 : 30; // buffer so ~5d holds 35 bars
  const to = Math.floor(Date.now() / 1000);
  const from = to - (days + extra) * 86400;

  const url = `${FINNHUB}?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${key}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) return null;

  const closes = data.c, opens = data.o, highs = data.h, lows = data.l, vols = data.v;
  return landmark({
    meta: {
      symbol: (symbol || '').toUpperCase(),
      regularMarketPrice: closes[closes.length - 1],
      regularMarketTime: data.t[data.t.length - 1],
      regularMarketPreviousClose: closes.length > 1 ? closes[closes.length - 2] : closes[0],
      currency: symbol.includes('.NS') ? 'INR' : 'USD',
      longName: symbol
    },
    timestamp: data.t,
    indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: vols }] }
  });
}

async function twelveChart(symbol, interval, range, exchange = null) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;

  const days = RANGE_DAYS[range] || 5;
  const output = days + 35;
  const isDailyish = (interval === '1d') || /^(1m|2m|5m|15m|30m|60m|1h)$/.test(interval);
  const tdInterval = isDailyish ? '1day' : '1day';

  let url = `${TWELVE}?symbol=${encodeURIComponent(symbol)}&interval=${tdInterval}&outputsize=${output}&timezone=UTC&apikey=${key}`;
  if (exchange) url += `&exchange=${exchange}`;

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  if (!d || !Array.isArray(d.values) || d.values.length === 0 || d.status === 'error') return null;

  const values = [...d.values].reverse(); // newest-first -> oldest-first
  const ts = [], opens = [], highs = [], lows = [], closes = [], vols = [];
  for (const row of values) {
    const t = Math.floor(Date.parse(`${row.datetime}T00:00:00Z`) / 1000);
    if (isNaN(t)) continue;
    ts.push(t);
    opens.push(parseFloat(row.open)); highs.push(parseFloat(row.high));
    lows.push(parseFloat(row.low)); closes.push(parseFloat(row.close));
    vols.push(row.volume ? parseInt(row.volume, 10) : 0);
  }
  if (ts.length === 0) return null;

  return landmark({
    meta: {
      symbol: (exchange ? `${symbol}.${exchange}` : symbol).toUpperCase(),
      regularMarketPrice: closes[closes.length - 1],
      regularMarketTime: ts[ts.length - 1],
      regularMarketPreviousClose: closes.length > 1 ? closes[closes.length - 2] : closes[0],
      currency: exchange ? 'INR' : (d.meta && (d.meta.currency || 'USD')) || 'USD',
      longName: symbol
    },
    timestamp: ts,
    indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: vols }] }
  });
}

let ySession = { cookie: null, crumb: null, at: 0 };
let diag = [];

// Mint a Yahoo session: collect cookies from the finance homepage + fc.yahoo.com,
// then exchange them for a crumb. The v7 quote endpoint REQUIRES cookie + crumb.
async function yahooCookies() {
  const jar = new Map();
  const push = (header) => {
    if (!header) return;
    for (const part of header.split(',')) {
      const kv = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=([^;]*)/);
      if (kv && !/^expires$/i.test(kv[1]) && kv[2].length <= 256 && !jar.has(kv[1])) {
        jar.set(kv[1], kv[2]);
      }
    }
  };
  for (const u of ['https://finance.yahoo.com/', 'https://fc.yahoo.com/']) {
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      push(r.headers.get('set-cookie') || '');
      diag.push(`cookies ${u} -> ${r.status}`);
    } catch (e) { diag.push(`cookies ${u} error: ${e.message}`); }
  }
  if (!jar.size) return null;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function yahooCrumb(force = false) {
  if (!force && ySession.crumb && Date.now() - ySession.at < 10 * 60 * 1000) {
    return ySession;
  }

  let cookie = ySession.cookie;
  if (!cookie) cookie = await yahooCookies();

  let crumb = '';
  for (const host of YAHOO_HOSTS) {
    try {
      const r2 = await fetch(`${host}/v1/test/getcrumb`, {
        headers: {
          'User-Agent': UA,
          'Cookie': cookie,
          'Accept': 'text/plain',
          'Referer': 'https://finance.yahoo.com/'
        }
      });
      const last = (await r2.text()).trim();
      diag.push(`getcrumb ${host} -> ${r2.status}`);
      if (r2.status === 200 && last && !/^Error/i.test(last)) { crumb = last; break; }
    } catch (e) { diag.push(`getcrumb ${host} error`); }
  }
  if (!crumb) throw new Error('crumb fetch failed');

  ySession = { cookie, crumb, at: Date.now() };
  return ySession;
}

async function yahooChart(symbol, interval, range) {
  // Crumb minting is often rate-limited (429) from DC IPs. The chart endpoint
  // frequently works without a crumb, so mint best-effort and fall back to
  // no-crumb requests instead of giving up entirely.
  let s = null;
  try { s = await yahooCrumb(); } catch (e) { diag.push(`crumb error (continuing w/o): ${e.message}`); }

  // Interleave hosts and crumb usage. If the IP is hard-throttled (429 on early
  // hosts) we bail fast instead of grinding through combos — the caller retries
  // on the next ticker poll anyway.
  const combos = [];
  if (s) {
    YAHOO_HOSTS.forEach((h) => combos.push({ host: h, crumb: true }, { host: h, crumb: false }));
  } else {
    YAHOO_HOSTS.forEach((h) => combos.push({ host: h, crumb: false }));
  }

  let lastRes = null;
  let throttledCount = 0;
  for (const a of combos) {
    const url = `${a.host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}` +
      (a.crumb ? `&crumb=${encodeURIComponent(s.crumb)}` : '');
    const headers = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://finance.yahoo.com/'
    };
    if (s) headers['Cookie'] = s.cookie;
    let res = null;
    try {
      res = await fetch(url, { headers });
    } catch (e) { diag.push(`chart ${a.host} fetch error`); continue; }
    lastRes = res;
    diag.push(`chart ${a.host} crumb=${a.crumb} -> ${res.status}`);
    if (res.status === 200) return res;
    if (res.status === 429) throttledCount++;
    if (res.status === 401 && s) break; // crumb gone stale; re-mint next call
    if (throttledCount >= Math.max(1, combos.length - 1)) break; // IP throttle: stop early
    await sleep(350);
  }
  return lastRes;
}

// Persistent last-known-good store: when every live provider is throttled, the
// proxy still returns the previous good payload flagged stale (never a dead tile).
const staleStore = new Map();
function staleSet(key, val) { staleStore.set(key, { v: val, t: Date.now() }); }
function staleGet(key) { const e = staleStore.get(key); return e ? { v: e.v, t: e.t } : null; }

// v7 batch quote — exact LTP, previous close + % change in ONE call. Needs cookie+crumb.
async function yahooQuoteBatch(symbols) {
  const s = await yahooCrumb();
  const qs = symbols.map(encodeURIComponent).join(',');
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `${host}/v7/finance/quote?symbols=${qs}&crumb=${encodeURIComponent(s.crumb)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, */*',
          'Referer': 'https://finance.yahoo.com/',
          'Cookie': s.cookie
        }
      });
      diag.push(`quote ${host} -> ${res.status}`);
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (j && j.quoteResponse && Array.isArray(j.quoteResponse.result)) return j.quoteResponse.result;
      }
    } catch (e) { diag.push(`quote ${host} error: ${e.message}`); }
    await sleep(700);
  }
  return null;
}

// Build quote rows from the no-crumb v8 chart endpoint (last close vs previous close).
async function yahooQuoteFromCharts(symbols) {
  const rows = [];
  await Promise.all(symbols.map(async (sym) => {
    try {
      const res = await yahooChart(sym, '1d', '5d');
      if (res && res.ok) {
        const data = await res.json();
        const r = data && data.chart && data.chart.result && data.chart.result[0];
        const meta = r && r.meta;
        if (meta && meta.regularMarketPrice != null) {
          const cur = meta.regularMarketPrice;
          const prev = meta.regularMarketPreviousClose;
          rows.push({
            symbol: sym,
            regularMarketPrice: cur,
            regularMarketChangePercent: prev ? ((cur / prev) - 1) * 100 : null,
            regularMarketPreviousClose: prev,
            regularMarketTime: meta.regularMarketTime,
            currency: meta.currency || 'INR'
          });
        }
      }
    } catch (e) { /* skip symbol */ }
  }));
  return rows.length ? rows : null;
}

// Trading Economics — India markets page contains NIFTY 50 + SENSEX quotes rendered
// server-side. Serves as a DC-IP-friendly "always-on" layer while Yahoo throttles us:
// one HTML fetch, parsed for label → price + % change. (No key, no CORS issues.)
async function tradesEconomicsQuotes() {
  try {
    const res = await fetch('https://tradingeconomics.com/india/stock-market', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const rows = [];
    const labelRe = /<a href="[^"]*">\s*([A-Z0-9& .]+?)\s*<\/a>/g;
    let m;
    while ((m = labelRe.exec(html))) {
      const name = m[1].trim();
      const look = html.slice(m.index, m.index + 300);
      const priceM = look.match(/id="p">([0-9.,]+)<\/td>/);
      const pctM = look.match(/id="pch"[^>]*>([\-0-9.]+)%/);
      if (!priceM) continue;
      const price = parseFloat(priceM[1].replace(/,/g, ''));
      if (isNaN(price)) continue;
      const lb = name.toLowerCase();
      const symbol = lb === 'nifty 50' ? '^NSEI' : lb === 'sensex' ? '^BSESN' : null;
      if (!symbol) continue;
      rows.push({
        symbol,
        regularMarketPrice: price,
        regularMarketChangePercent: pctM ? parseFloat(pctM[1]) : null,
        regularMarketTime: Math.floor(Date.now() / 1000),
        currency: 'INR',
        _srcName: 'TradingEconomics'
      });
    }
    return rows.length ? rows : null;
  } catch (e) { return null; }
}

export default async (event, context) => {
  const isRequest = event && typeof event === 'object' && typeof event.url === 'string' && Object.keys(event).length === 0;
  const method = isRequest ? event.method : (event && event.httpMethod) || 'GET';
  if (method === 'OPTIONS') return corsResponse('OK', 204);

  let params = {};
  if (isRequest) {
    params = Object.fromEntries(new URL(event.url).searchParams.entries());
  } else if (event && typeof event.queryStringParameters === 'object') {
    params = event.queryStringParameters;
  }

  const symbol = params.symbol;
  const interval = ALLOWED_INTERVALS.has(params.interval) ? params.interval : '5m';
  let range = params.range || '5d';
  if (!/^[a-zA-Z0-9]+$/.test(range)) range = '5d';

  if (params.mode === 'news') return await handleNews(params.topic || 'markets');

  // Batch live quote endpoint (used by the market ticker): ONE call for all indices.
  if (params.mode === 'quote') {
    const symbols = String(params.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
    if (!symbols.length) return corsResponse(JSON.stringify({ error: 'symbols required' }), 400);
    const qKey = 'quote|' + [...symbols].sort().join(',');
    const qCached = cached(qKey);
    if (qCached) return corsResponse(JSON.stringify(qCached), 200, { 'Cache-Control': 'public, max-age=15' });
    const wantDebug = params.debug === '1';
    diag = [];
    const merged = new Map();
    const put = (row, live, delayed, held, asOf) => {
      const prev = merged.get(row.symbol);
      if (prev && !prev._held) return; // keep a fresher value over held
      merged.set(row.symbol, { ...row, _live: live, _delayed: delayed, _held: held, _asOf: asOf });
    };

    // Layer 1 — Trading Economics (DC-friendly headline indices, always-on when Yahoo throttles)
    try {
      const te = await tradesEconomicsQuotes();
      if (te) te.forEach((r) => put(r, true, false, false, null));
    } catch (e) { diag.push(`te error: ${e.message}`); }

    // Layer 2 — Yahoo v7 batch (all four, exact LTP; needs cookie+crumb)
    try {
      const y = await yahooQuoteBatch(symbols);
      if (y) y.forEach((r) => put(r, true, false, false, null));
    } catch (e) { diag.push(`quote batch error: ${e.message}`); }

    // Layer 3 — v8 chart fills for whatever is still missing (delayed, last close)
    const needChart = symbols.filter((s) => !merged.has(s));
    if (needChart.length) {
      const c = await yahooQuoteFromCharts(needChart);
      if (c) c.forEach((r) => put(r, false, true, false, null));
    }

    // Layer 4 — held last-known-good values for anything still missing (never a dead tile)
    const needHeld = symbols.filter((s) => !merged.has(s));
    if (needHeld.length) {
      const st = staleGet(qKey);
      if (st) st.v.filter((r) => needHeld.includes(r.symbol)).forEach((r) => put(r, false, false, true, st.t));
    }

    const result = [...merged.values()];
    if (result.length) {
      const anyHeld = result.some((r) => r._held);
      const anyYahoo = result.some((r) => r._srcName === 'Yahoo');
      const anyTE = result.some((r) => r._srcName === 'TradingEconomics');
      const body = {
        quoteResponse: { result },
        _src: anyYahoo ? (anyTE ? 'yahoo+te' : 'yahoo') : (anyTE ? 'te' : 'chart'),
        _stale: result.every((r) => r._held),
        _asOf: Date.now(),
        _freshCount: result.filter((r) => !r._held).length
      };
      if (!body._stale) { cacheSet(qKey, body); staleSet(qKey, result); }
      return corsResponse(JSON.stringify(body), 200, { 'Cache-Control': 'public, max-age=15' });
    }
    const body = { error: 'live sources unavailable', detail: 'all quote sources throttled' };
    if (wantDebug) body.diag = diag.slice(-12);
    return corsResponse(JSON.stringify(body), 200, { 'Cache-Control': 'public, max-age=30' });
  }

  if (!symbol) return corsResponse(JSON.stringify({ error: 'symbol is required' }), 400);
  if (!/^[A-Za-z0-9.^\-=]+$/.test(symbol)) return corsResponse(JSON.stringify({ error: 'invalid symbol' }), 400);

  const cacheKey = `${symbol}|${interval}|${range}`;
  const fromCache = cached(cacheKey);
  if (fromCache) return corsResponse(JSON.stringify(fromCache), 200, { 'Cache-Control': 'public, max-age=15' });

  let out = null;
  const wantDebug = params.debug === '1';
  diag = [];

  // INR / NSE / BSE symbols -> Finnhub .NS first, TwelveData (NSE/BSE) second
  if (isIndia(symbol)) {
    if (process.env.FINNHUB_API_KEY) out = await finnhubChart(symbol, interval, range);
    if (!out && process.env.TWELVEDATA_API_KEY) {
      out = await twelveChart(indiaBase(symbol), interval, range, indiaExchange(symbol));
    }
  }

  // USD / US symbols -> Finnhub first, Twelve Data as secondary
  if (!out && process.env.FINNHUB_API_KEY) {
    out = await finnhubChart(symbol, interval, range);
  }
  if (!out && process.env.TWELVEDATA_API_KEY) {
    out = await twelveChart(symbol, interval, range);
  }

  if (out) {
    cacheSet(cacheKey, out);
    staleSet(cacheKey, out); // remember the last good candles so the tile never goes dead
    return corsResponse(JSON.stringify(out), 200, { 'Cache-Control': 'public, max-age=15' });
  }

  // Last resort: Yahoo best effort
  try {
    const res = await yahooChart(symbol, interval, range);
    if (res && res.ok) {
      const data = await res.json();
      cacheSet(cacheKey, data);
      staleSet(cacheKey, data);
      return corsResponse(JSON.stringify(data), 200, { 'Cache-Control': 'public, max-age=15' });
    }
    const detail = res ? await res.text().catch(() => '') : '';
    const body = { error: 'live sources unavailable', detail: detail.slice(0, 200) };
    if (wantDebug) body.diag = diag.slice(-12);
    // Best effort: serve the last successful candles for this symbol (flagged stale)
    const st = staleGet(cacheKey);
    if (st && st.v && st.v.chart && st.v.chart.result) {
      return corsResponse(JSON.stringify({ ...st.v, _stale: true, _asOf: st.t }), 200, { 'Cache-Control': 'public, max-age=30' });
    }
    return corsResponse(JSON.stringify(body), 200, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    const body = { error: 'live sources unavailable', detail: e.message };
    if (wantDebug) body.diag = diag.slice(-12);
    const st = staleGet(cacheKey);
    if (st && st.v && st.v.chart && st.v.chart.result) {
      return corsResponse(JSON.stringify({ ...st.v, _stale: true, _asOf: st.t }), 200, { 'Cache-Control': 'public, max-age=30' });
    }
    return corsResponse(JSON.stringify(body), 200, { 'Cache-Control': 'public, max-age=30' });
  }
};

function corsResponse(body, statusCode = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders
  };
  return new Response(body, { status: statusCode, headers });
}

// ---- News (Google News RSS + reliable business feeds, server-side to dodge CORS) ----
function buildGoogleNewsUrl(q, locale) {
  const qq = encodeURIComponent(q).replace(/%20/g, '+');
  const loc = locale === 'in'
    ? 'hl=en-IN&gl=IN&ceid=IN:en'
    : 'hl=en-US&gl=US&ceid=US:en';
  return `https://news.google.com/rss/search?q=${qq}&${loc}`;
}

async function fetchAndParseRSS(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('rss-upstream-' + res.status);
  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const tag = (name) => {
      const r = new RegExp(`<${name}(?:[^>]*)>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const title = tag('title');
    const link = tag('link');
    const pubDate = tag('pubDate');
    const source = (tag('source') || '').trim();
    if (title) {
      let pretty = source;
      if (!pretty && link) {
        try { pretty = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { pretty = ''; }
      }
      items.push({ title, link, pubDate, source: pretty });
    }
    if (items.length >= 10) break;
  }
  return items;
}

async function handleNews(topic) {
  const feeds = NEWS_FEEDS[topic] || NEWS_FEEDS.markets;
  const items = [];
  for (const f of feeds) {
    try {
      const url = f.src.startsWith('google:') ? buildGoogleNewsUrl(f.src.slice(7), f.locale) : f.src;
      const got = await fetchAndParseRSS(url);
      for (const it of got) {
        if (!items.some(y => y.title === it.title)) items.push({ ...it });
        if (items.length >= 12) break;
      }
    } catch (e) { /* next source */ }
    if (items.length >= 12) break;
  }

  if (!items.length) {
    (NEWS_CURATED[topic] || NEWS_CURATED.markets).forEach(t => items.push({ title: t, link: '', pubDate: '', source: 'curated offline' }));
  }

  return corsResponse(JSON.stringify({ topic, count: items.length, items }), 200, { 'Cache-Control': 'public, max-age=120' });
}