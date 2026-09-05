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

async function yahooCrumb(force = false) {
  if (!force && ySession.crumb && Date.now() - ySession.at < 10 * 60 * 1000) return ySession;

  const r1 = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA, 'Accept': '*/*' }
  });
  const setCookie = r1.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0].split(',')[0].trim();
  diag.push(`fc.yahoo.com -> ${r1.status}`);

  let crumb = '', last = '';
  for (const host of YAHOO_HOSTS) {
    const r2 = await fetch(`${host}/v1/test/getcrumb`, {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/plain' }
    });
    last = (await r2.text()).trim();
    diag.push(`getcrumb ${host} -> ${r2.status}`);
    if (r2.status === 200 && last && last.length <= 64) { crumb = last; break; }
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

  // Interleave hosts and crumb usage; retry with growing backoff for transient 429s
  const combos = [];
  if (s) {
    YAHOO_HOSTS.forEach((h) => combos.push({ host: h, crumb: true }));
    YAHOO_HOSTS.forEach((h) => combos.push({ host: h, crumb: false }));
  } else {
    YAHOO_HOSTS.forEach((h) => combos.push({ host: h, crumb: false }));
  }
  combos.push(...combos); // second pass after backoff

  let lastRes = null;
  let waitMs = 600;
  for (const a of combos) {
    const url = `${a.host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}` +
      (a.crumb ? `&crumb=${encodeURIComponent(s.crumb)}` : '');
    const headers = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://finance.yahoo.com/'
    };
    if (s) headers['Cookie'] = s.cookie;
    const res = await fetch(url, { headers });
    lastRes = res;
    diag.push(`chart ${a.host} crumb=${a.crumb} -> ${res.status}`);
    if (res.status === 200) return res;
    if (res.status === 401 || res.status === 403 && s) break; // crumb gone stale; re-mint next call
    await sleep(waitMs);
    waitMs = Math.min(2500, waitMs * 2);
  }
  return lastRes;
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
    return corsResponse(JSON.stringify(out), 200, { 'Cache-Control': 'public, max-age=15' });
  }

  // Last resort: Yahoo best effort
  try {
    const res = await yahooChart(symbol, interval, range);
    if (res && res.ok) {
      const data = await res.json();
      cacheSet(cacheKey, data);
      return corsResponse(JSON.stringify(data), 200, { 'Cache-Control': 'public, max-age=15' });
    }
    const detail = res ? await res.text().catch(() => '') : '';
    const body = { error: 'live sources unavailable', detail: detail.slice(0, 200) };
    if (wantDebug) body.diag = diag.slice(-12);
    return corsResponse(JSON.stringify(body), 200, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    const body = { error: 'live sources unavailable', detail: e.message };
    if (wantDebug) body.diag = diag.slice(-12);
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
function buildGoogleNewsUrl(q) {
  const qq = encodeURIComponent(q).replace(/%20/g, '+');
  return `https://news.google.com/rss/search?q=${qq}&hl=en-US&gl=US&ceid=US:en`;
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
      const url = f.src.startsWith('google:') ? buildGoogleNewsUrl(f.src.slice(7)) : f.src;
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