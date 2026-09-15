// Netlify Function: Live Indian IPO board (point-in-time open / upcoming / recent).
// Fetches ipowatch.in's "Upcoming IPO List" page, parses the tablepress tables
// (mainboard + SME), computes booking status from the date windows, and serves an
// in-depth summary per IPO from its detail page on request. No API keys required.
//
//   GET /functions/ipos              -> { mainboard: [...], sme: [...] } with status
//   GET /functions/ipos?detail=SLUG  -> in-depth analysis for one IPO

const IPOWATCH_LIST = 'https://ipowatch.in/upcoming-ipo-list/';
const IPOWATCH_BASE = 'https://ipowatch.in';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function monthIndex(name) {
  const low = String(name || '').toLowerCase();
  return MONTHS.indexOf(low) !== -1 ? MONTHS.indexOf(low) : MONTH_ABBR[low.slice(0, 3)];
}

const LIST_TTL_MS = 30 * 60 * 1000;   // list page is ~600kB; cache 30 min
const DETAIL_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CACHE = 120;

// Tiny module-scope cache (per warm instance).
const cache = new Map();
function cacheGet(key, ttlMs) {
  const e = cache.get(key);
  if (e && Date.now() - e.t < ttlMs) return e.d;
  return null;
}
function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), d: v });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

const fetchWithTimeout = async (url, ms = 20000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow'
    });
  } finally {
    clearTimeout(timer);
  }
};

function strip(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Current date in IST, reduced to a UTC-midnight timestamp for clean comparisons.
function istTodayUTC() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return Date.UTC(+get('year'), +get('month') - 1, +get('day'));
}
function istTodayParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function daysInMonth(year, m) {
  return new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
}

// Parses ipowatch date-window strings like "24-28 September", "31-2 September",
// "28-1 September", "30-03 Feb". Returns UTC-midnight timestamps + pretty labels.
function parseDateRange(s, year) {
  const m = /^\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)/.exec(String(s || '').trim());
  if (!m) return null;
  const d1 = +m[1];
  const d2 = +m[2];
  const month = monthIndex(m[3]);
  if (month === -1 || !d1 || !d2) return null;

  let openY = year, openM = month, openD = d1;
  let closeY = year, closeM = month, closeD = d2;

  // "31-2 September" / "28-1 September": the open day belongs to the previous month.
  if (d1 >= d2) {
    openM = month - 1;
    if (openM < 0) { openM = 11; openY -= 1; }
  } else if (d1 > daysInMonth(year, month)) {
    openM = month - 1;
    if (openM < 0) { openM = 11; openY -= 1; }
  }
  if (closeD > daysInMonth(year, month)) closeD = daysInMonth(year, month);

  const open = Date.UTC(openY, openM, openD);
  const close = Date.UTC(closeY, closeM, closeD);
  if (!open || !close) return null;
  const fmt = (u) => {
    const d = new Date(u);
    return d.toLocaleString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  };
  return { open, close, openLabel: fmt(open), closeLabel: fmt(close), raw: String(s).trim() };
}

function rowCells(tr) {
  return [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]);
}

// --- List endpoint ---------------------------------------------------------
function parseList(html) {
  const tables = {};
  const tblRe = /<table[^>]*id="tablepress-(\d+)"[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = tblRe.exec(html))) tables[m[1]] = m[2];

  const year = new Date(istTodayUTC()).getUTCFullYear();
  const today = istTodayUTC();

  const toItems = (rows, kind) => {
    const items = [];
    for (const tr of rows) {
      if (!/<tr[^>]*>/i.test(tr)) continue;
      const cells = rowCells(tr).map((c) => strip(c));
      const hrefs = [...tr.matchAll(/href="([^"]+)"/g)].map((h) => h[1]);
      const detail = hrefs.find((h) => /^https:\/\/ipowatch\.in\/[a-z0-9-]+\/?$/.test(h))
        || hrefs.find((h) => /^\/(?:'|\/)?[a-z0-9-]+/i.test(h) && !h.includes('zerodha') && !h.includes('chittorgarh'));
      if (!detail || !hrefs.some((h) => /zerodha|^\/(?:'|\/)?[a-z0-9-]/.test(h))) continue;

      let slug;
      let url;
      if (detail.startsWith('http')) {
        slug = detail.replace(/\/$/, '').split('/').pop();
        url = detail;
      } else {
        slug = detail.replace(/^\/+/, '').replace(/\/$/, '');
        url = IPOWATCH_BASE + '/' + slug + '/';
      }
      if (!slug) continue;

      const parts = kind === 'sme' ? cells : cells;
      // mainboard: [Company, Date, Size, Band, Application]
      // sme:       [IPO, Date, Size, Band, Platform, Application]
      const name = parts[0];
      const dateRaw = parts[1];
      const size = parts[2];
      const band = parts[3];
      const platform = kind === 'sme' ? (parts[4] || '') : '';
      if (!name || !dateRaw) continue;

      const rng = parseDateRange(dateRaw, year);
      let status = 'UNKNOWN';
      if (rng) {
        if (today >= rng.open && today <= rng.close) status = 'OPEN';
        else if (today < rng.open) status = 'UPCOMING';
        else status = 'CLOSED';
      }
      items.push({
        name,
        slug,
        url,
        platform,
        kind,
        dateWindow: dateRaw,
        openLabel: rng ? rng.openLabel : null,
        closeLabel: rng ? rng.closeLabel : null,
        openDate: rng ? new Date(rng.open).toISOString().slice(0, 10) : null,
        closeDate: rng ? new Date(rng.close).toISOString().slice(0, 10) : null,
        size, priceBand: band,
        status
      });
    }
    return items;
  };

  const mainboard = toItems((tables['22'] || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [], 'main');
  const sme = toItems((tables['23'] || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [], 'sme');
  return { mainboard, sme };
}

async function getList() {
  const cached = cacheGet('list', LIST_TTL_MS);
  if (cached) return cached;

  const res = await fetchWithTimeout(IPOWATCH_LIST);
  if (!res.ok) {
    const st = cacheGet('list', 24 * 60 * 60 * 1000);
    if (st) return st;
    throw new Error('ipowatch-list-' + res.status);
  }
  const html = await res.text();
  const parsed = parseList(html);
  const body = {
    ok: true,
    source: 'ipowatch.in',
    asOf: istTodayParts(),
    fetchedAt: new Date().toISOString(),
    mainboard: parsed.mainboard,
    sme: parsed.sme
  };
  // keep a longer stale copy so a brief upstream outage never kills the board
  cacheSet('list', body);
  cacheSet('list_stale', body);
  return body;
}

// --- Detail endpoint -------------------------------------------------------
function sectionList(html) {
  const out = [];
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  let m;
  while ((m = h2Re.exec(html))) {
    const title = strip(m[1]).replace(/\s+/g, ' ').trim();
    out.push({ start: m.index, end: m.index + m[0].length, title });
  }
  return out;
}

function nextSectionStart(sections, i) {
  return i + 1 < sections.length ? sections[i + 1].start : sections[i].end + 60000;
}

function firstParagraph(slice) {
  const p = slice.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  return p ? strip(p[1]) : '';
}

function tableData(slice) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(slice))) {
    const cells = rowCells(m[1]).map((c) => strip(c)).filter((c) => c);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function sectionByTitle(sections, words) {
  return sections.find((s) => words.some((w) => new RegExp(w, 'i').test(s.title)));
}

function parseDetail(html) {
  const sections = sectionList(html);
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleMatch ? strip(titleMatch[1]) : '';
  const detail = {
    title: rawTitle
      .replace(/\s*[-|]\s*IPO Watch\s*$/i, '')
      .replace(/\s+IPO Date, Review, Price, Allotment Details\s*$/i, '')
      .replace(/\s+IPO[\s-]*Details\s*$/i, '')
      .trim(),
    url: /<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(html)?.[1] || ''
  };

  // IPO Details table
  const detailsSec = sectionByTitle(sections, ['\\bIPO Details\\b']);
  if (detailsSec) {
    const rows = tableData(html.slice(detailsSec.end, nextSectionStart(sections, sections.indexOf(detailsSec))));
    const byLabel = {};
    for (const r of rows) {
      if (r.length === 2 && r[0]) byLabel[r[0].toLowerCase()] = r[1];
    }
    const pick = (k) => byLabel[k] || null;
    detail.openDate = pick('ipo open date');
    detail.closeDate = pick('ipo close date');
    detail.faceValue = pick('face value');
    detail.priceBand = pick('ipo price band');
    detail.issueSize = pick('issue size');
    detail.freshIssue = pick('fresh issue');
    detail.issueType = pick('issue type');
    detail.listing = pick('ipo listing');
    detail.otherFields = Object.entries(byLabel)
      .filter(([k]) => !['ipo open date', 'ipo close date', 'face value', 'ipo price band', 'issue size', 'fresh issue', 'issue type', 'ipo listing'].includes(k))
      .slice(0, 10)
      .map(([k, v]) => ({ label: k, value: v.slice(0, 120) }));
  }

  // Market lot
  const lotSec = sectionByTitle(sections, ['\\bMarket Lot\\b']);
  if (lotSec) {
    const slice = html.slice(lotSec.end, nextSectionStart(sections, sections.indexOf(lotSec)));
    const p = firstParagraph(slice);
    if (p) detail.lotSummary = p.slice(0, 400);
    const lotRows = tableData(slice);
    if (lotRows.length) detail.lotRows = lotRows.slice(0, 6);
  }

  // About
  const aboutSec = sectionByTitle(sections, ['^About\\b', 'Company Introduction', '\\bAbout the Company\\b']);
  if (aboutSec) {
    const slice = html.slice(aboutSec.end, nextSectionStart(sections, sections.indexOf(aboutSec)));
    const p = firstParagraph(slice);
    if (p) detail.about = p.slice(0, 1600);
  }

  // Financial performance
  const finSec = sectionByTitle(sections, ['Financial Performance']);
  if (finSec) {
    const slice = html.slice(finSec.end, nextSectionStart(sections, sections.indexOf(finSec)));
    const paras = [...slice.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((pp) => strip(pp[1])).filter(Boolean);
    if (paras.length) detail.financials = paras.join(' ').slice(0, 2000);
  }

  // Conclusion -> verdict + paragraph
  const concSec = sectionByTitle(sections, ['^Conclusion\\b']);
  if (concSec) {
    const verdict = concSec.title.replace(/^Conclusion\s*[-–:]\s*/i, '').replace(/^Conclusion\b/i, '').trim();
    if (verdict) detail.verdict = verdict.slice(0, 120);
    const slice = html.slice(concSec.end, nextSectionStart(sections, sections.indexOf(concSec)));
    const p = firstParagraph(slice);
    if (p) detail.conclusion = p.slice(0, 1600);
  }

  // Objects of the issue
  const objSec = sectionByTitle(sections, ['\\bObjects of the Issue\\b', '\\bObjectives of the Issue\\b']);
  if (objSec) {
    const rows = tableData(html.slice(objSec.end, nextSectionStart(sections, sections.indexOf(objSec))));
    const objs = rows.filter((r) => r.length >= 2 && !/^(purpose|utilisation|objects|application of)/i.test(r[0]));
    if (objs.length) detail.objectives = objs.slice(0, 8).map((r) => ({ purpose: r[0], amount: r[r.length - 1] }));
  }

  return detail;
}

async function getDetail(slug) {
  const key = 'd|' + slug;
  const cached = cacheGet(key, DETAIL_TTL_MS);
  if (cached) return cached;

  const url = `${IPOWATCH_BASE}/${slug}/`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('ipowatch-detail-' + res.status);
  const html = await res.text();
  if (/<title[^>]*>\s*404[^<]*<\/title>/i.test(html) || /page not found/i.test(html.slice(0, 2000))) {
    throw new Error('ipowatch-detail-404');
  }
  const body = { ok: true, slug, url, ...parseDetail(html) };
  cacheSet(key, body);
  return body;
}

// --- Handler ---------------------------------------------------------------
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

export default async (event, context) => {
  let method = 'GET';
  let params = {};
  if (event && typeof event === 'object' && typeof event.url === 'string') {
    method = event.method || 'GET';
    params = Object.fromEntries(new URL(event.url).searchParams.entries());
  } else if (event && typeof event.queryStringParameters === 'object') {
    method = event.httpMethod || 'GET';
    params = event.queryStringParameters;
  } else if (event && typeof event.parameters === 'object') {
    params = event.parameters;
  }
  if (method === 'OPTIONS') return corsResponse('OK', 204);

  try {
    const slug = String(params.detail || '').trim();
    if (slug) {
      if (!/^[a-z0-9-]+$/i.test(slug)) return corsResponse(JSON.stringify({ ok: false, error: 'invalid slug' }), 400);
      try {
        return corsResponse(JSON.stringify(await getDetail(slug)), 200, { 'Cache-Control': 'public, max-age=600' });
      } catch (e) {
        return corsResponse(JSON.stringify({ ok: false, error: 'unavailable', detail: e.message }), 200, { 'Cache-Control': 'public, max-age=60' });
      }
    }

    let body;
    try {
      body = await getList();
    } catch (e) {
      const st = cacheGet('list_stale', 24 * 60 * 60 * 1000);
      if (st) return corsResponse(JSON.stringify(st), 200, { 'Cache-Control': 'public, max-age=120' });
      throw e;
    }
    const count = (body.mainboard || []).length + (body.sme || []).length;
    return corsResponse(JSON.stringify(body), 200, {
      'Cache-Control': 'public, max-age=300',
      'X-Count': String(count)
    });
  } catch (e) {
    return corsResponse(JSON.stringify({ ok: false, error: 'upstream', detail: e.message }), 200, { 'Cache-Control': 'public, max-age=60' });
  }
};