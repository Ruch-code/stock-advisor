// Quality Dip Scanner — free keyless NSE depth layer.
// Server-side (CORS-safe) so app.html cards get REAL, honest dip candidates:
//   route=dip    → NSE losers by % vs prev close (today's weaker-price names, ascending)
//   route=vol    → NSE most-active by volume (liquidity filter so dips are tradable)
// Fundamentals (ROCE/ROE/D:E/PE/promoter/FII-DII) are NOT on these keyless public
// endpoints — the card gates them as honest methodology checks, never fabricated.
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function cors(){ return { 'access-control-allow-origin':'*','content-type':'application/json; charset=utf-8' }; }
async function nse(path){
  const jar=await fetch('https://www.nseindia.com/',{headers:{'user-agent':UA,'accept':'text/html'}});
  const ck=(jar.headers.get('set-cookie')||'').split(';')[0];
  const r=await fetch('https://www.nseindia.com/api/'+path,{headers:{'user-agent':UA,'accept':'application/json, text/plain, */*','cookie':ck,'referer':'https://www.nseindia.com/'}});
  return r.json();
}
exports.handler = async function(ev){
  const h=cors(); let data;
  try{
    const q=ev.queryStringParameters||{};
    const r=q.r||'dip';
    if(r==='dip') data=await nse('live-analysis-variations?index=losers');
    else if(r==='vol') data=await nse('live-analysis-most-active-securities?index=sec_volume');
    else return {statusCode:400,headers:h,body:JSON.stringify({ok:false,err:'unknown route'})};
    return {statusCode:200,headers:h,body:JSON.stringify({ok:true,gate:true,ts:Date.now(),route:r,data})};
  }catch(e){ return {statusCode:502,headers:h,body:JSON.stringify({ok:false,gate:true,err:String(e&&e.message||e)})}; }
};
