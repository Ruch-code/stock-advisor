// Honest NSE depth proxy — free serverless. NSE blocks browsers (CORS) so the
// card fetch runs HERE on the free tier, then streams clean JSON to app.html.
// Failure (rate-limit / feed rotation) returns gate:true → card shows honest "—".
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function nseFeed(path) {
  const jar = await fetch('https://www.nseindia.com/', {
    headers: { 'user-agent': UA, 'accept': 'text/html' }
  });
  const ck = (jar.headers.get('set-cookie') || '').split(';')[0];
  const r = await fetch('https://www.nseindia.com/api/' + path, {
    headers: { 'user-agent': UA, 'accept': 'application/json, text/plain, */*', 'cookie': ck, 'referer': 'https://www.nseindia.com/' }
  });
  return r.json();
}

exports.handler = async function (event) {
  const route = (event.queryStringParameters || {}).r || '';
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' };
  try {
    let data;
    if (route === 'pcr') data = await nseFeed('option-chain-indices?symbol=NIFTY');
    else if (route === 'delivery') data = await nseFeed('historical/securityArchives?from=01-01-2026&to=19-09-2026&symbol=RELIANCE');
    else if (route === 'topactives') data = await nseFeed('live-analysis-most-active-securities?index=sec_volume');
    else if (route === 'losers') data = await nseFeed('live-analysis-variations?index=losers');
    else return { statusCode: 400, headers: cors, body: 'unknown route' };
    const out = { gate: true, ok: true, ts: Date.now(), data };
    return { statusCode: 200, headers: cors, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ gate: true, ok: false, err: String(e && e.message || e) }) };
  }
};
