// Netlify Function: proxy chart/quote data server-side.
// Strategy (layered so the static site always gets candles without exposing keys):
//   1) Finnhub (free API key via FINNHUB_API_KEY env var) - reliable from datacenter IPs
//   2) Yahoo Finance crumb+session flow - best effort; often 429s datacenter IPs
// Why a function at all: Yahoo/TerminalFeed block plain browser CORS requests.

const YAHOO_HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const ALLOWED_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1h', '1d', '1wk', '1mo']);
const FINNHUB = 'https://finnhub.io/api/v1/stock/candle';

const RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730, '5y': 1825, 'max': 9130 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ySession = { cookie: null, crumb: null, at: 0 };

async function yahooCrumb(force = false) {
  if (!force && ySession.crumb && Date.now() - ySession.at < 10 * 60 * 1000) return ySession;
  const r1 = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA, 'Accept': '*/*' }
  });
  const setCookie = r1.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0].split(',')[0].trim();

  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/plain' }
  });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 64) throw new Error('crumb fetch failed');
  ySession = { cookie, crumb, at: Date.now() };
  return ySession;
}

async function yahooChart(symbol, interval, range) {
  let s;
  try { s = await yahooCrumb(); } catch (e) { throw e; }

  const attempts = [];
  YAHOO_HOSTS.forEach((h) => attempts.push({ host: h, crumb: true }));
  YAHOO_HOSTS.forEach((h) => attempts.push({ host: h, crumb: false }));

  let lastRes = null;
  for (const a of attempts) {
    const url = `${a.host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}` +
      (a.crumb ? `&crumb=${encodeURIComponent(s.crumb)}` : '');
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://finance.yahoo.com/',
        'Cookie': s.cookie
      }
    });
    lastRes = res;
    if (res.status === 200) return res;
    await sleep(600);
  }
  return lastRes;
}

async function finnhubChart(symbol, interval, range) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  // Finnhub resolution: D (free tier). Intraday '60' costs extra and is patchy;
  // keep daily candles for reliability. Extra bars = early lookback for patterns.
  const days = RANGE_DAYS[range] || 5;
  const extra = interval === '1d' ? 0 : 30; // buffer so ~5d holds 35 bars
  const to = Math.floor(Date.now() / 1000);
  const from = to - (days + extra) * 86400;

  const url = `${FINNHUB}?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${key}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) return null;

  // Shape into Yahoo-chart JSON so the client's processYahooToCandles() is unchanged
  const closes = data.c, opens = data.o, highs = data.h, lows = data.l, vols = data.v;
  const chart = {
    chart: {
      result: [{
        meta: {
          symbol: (symbol || '').toUpperCase(),
          regularMarketPrice: closes[closes.length - 1],
          regularMarketTime: data.t[data.t.length - 1],
          regularMarketPreviousClose: closes.length > 1 ? closes[closes.length - 2] : closes[0],
          currency: 'USD',
          longName: symbol
        },
        timestamp: data.t,
        indicators: {
          quote: [{ open: opens, high: highs, low: lows, close: closes, volume: vols }]
        }
      }],
      error: null
    }
  };
  return chart;
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

  if (!symbol) return corsResponse(JSON.stringify({ error: 'symbol is required' }), 400);
  if (!/^[A-Za-z0-9.\-=]+$/.test(symbol)) return corsResponse(JSON.stringify({ error: 'invalid symbol' }), 400);

  // 1) Finnhub (when key configured)
  try {
    const fh = await finnhubChart(symbol, interval, range);
    if (fh) return corsResponse(JSON.stringify(fh), 200, { 'Cache-Control': 'public, max-age=15' });
  } catch (e) { /* fall through */ }

  // 2) Yahoo best-effort
  try {
    const res = await yahooChart(symbol, interval, range);
    if (res && res.ok) {
      const data = await res.json();
      return corsResponse(JSON.stringify(data), 200, { 'Cache-Control': 'public, max-age=15' });
    }
    const detail = res ? await res.text().catch(() => '') : '';
    return corsResponse(JSON.stringify({ error: 'live sources unavailable', detail: detail.slice(0, 200) }), 200, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    return corsResponse(JSON.stringify({ error: 'live sources unavailable', detail: e.message }), 200, { 'Cache-Control': 'public, max-age=30' });
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