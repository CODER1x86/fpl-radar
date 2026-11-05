// FPL Radar read-only proxy: lets the FPL Radar web app read PUBLIC FPL endpoints for any team id.
// Only an allowlist of GET endpoints is forwarded; nothing that needs a login is reachable; responses are cached.
const FPL = "https://fantasy.premierleague.com/api";
const ROUTES = [
  [/^\/entry\/\d{1,9}\/$/, 300],
  [/^\/entry\/\d{1,9}\/history\/$/, 600],
  [/^\/entry\/\d{1,9}\/transfers\/$/, 600],
  [/^\/entry\/\d{1,9}\/event\/\d{1,2}\/picks\/$/, 600],
  [/^\/leagues-classic\/\d{1,9}\/standings\/$/, 300],
  [/^\/event\/\d{1,2}\/live\/$/, 60],
  [/^\/fixtures\/$/, 1800],
  [/^\/bootstrap-static\/$/, 300],
];

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  const ok = allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function kick(env) {
  if (!env.GH_TOKEN) return "no GH_TOKEN";
  const r = await fetch("https://api.github.com/repos/CODER1x86/fpl-radar/actions/workflows/pipeline.yml/dispatches", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json",
               "User-Agent": "fpl-radar-cron", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { mode: "auto" } }),
  });
  return `dispatch ${r.status}`;
}

// Cadence gate: the pipeline publishes data/schedule.json (quiet = hourly, last 36 h before a deadline = every
// 5-10 min). The cron fires every 5 min but only starts a run when one is due. No schedule yet -> run.
async function due(env) {
  const base = (env.PAGES_URL || "https://coder1x86.github.io/fpl-radar/").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/data/schedule.json?ts=${Date.now()}`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return [true, `schedule ${r.status}`];
    const s = await r.json();
    const ok = Date.now() >= Date.parse(s.next_due) - 90 * 1000;
    return [ok, `${s.phase} next ${s.next_due}`];
  } catch (e) { return [true, `schedule error ${e}`]; }
}

// Ask Radar: free Workers AI (10,000 Neurons/day on the Free plan; over the limit calls fail, nothing is billed).
// The app sends the question plus a compact summary of the user's own projections; the model answers ONLY from it.
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
const SYSTEM = `You are FPL Radar, a Fantasy Premier League assistant. Answer using ONLY the data in the CONTEXT block
(projected points "xP" from the Radar model, prices, availability, fixtures). If the data does not cover the question,
say so. Give a clear recommendation first, then 2-4 short reasons with numbers from the context, then a confidence level
(high/medium/low). Never invent injuries, news or statistics. Reply in the language of the question
(Egyptian Arabic if the question is in Arabic). Keep it under 150 words.`;
async function ask(req, env, h, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  if (!allowed.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return Response.json({ error: "origin not allowed" }, { status: 403, headers: h });
  if (!env.AI) return Response.json({ error: "AI binding missing" }, { status: 503, headers: h });
  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: "bad json" }, { status: 400, headers: h }); }
  const q = String(body.q || "").slice(0, 500), context = String(body.context || "").slice(0, 12000);
  if (!q.trim()) return Response.json({ error: "empty question" }, { status: 400, headers: h });
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: `CONTEXT:\n${context}\n\nQUESTION: ${q}` }];
  let last = "";
  for (const m of MODELS) {
    try {
      const r = await env.AI.run(m, { messages, max_tokens: 400, temperature: 0.2 });
      const text = (r && (r.response || (r.result && r.result.response))) || "";
      if (text) return Response.json({ answer: text, model: m }, { headers: h });
    } catch (e) { last = String(e && e.message || e); }
  }
  const quota = /neuron|quota|limit|429/i.test(last);
  return Response.json({ error: quota ? "daily free limit reached — try again after 02:00 Cairo" : "AI unavailable", detail: last.slice(0, 200) }, { status: quota ? 429 : 502, headers: h });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(due(env).then(async ([ok, why]) => console.log(why, ok ? await kick(env) : "skip")));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin, env);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    if (req.method === "POST" && url.pathname === "/ai") return ask(req, env, h, origin);
    if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: h });
    if (url.pathname === "/health") return Response.json({ ok: true }, { headers: h });
    const path = url.pathname.replace(/^\/api/, "");
    const route = ROUTES.find(([re]) => re.test(path));
    if (!route) return Response.json({ error: "endpoint not allowed" }, { status: 404, headers: h });
    const qs = path.startsWith("/leagues-classic/") ? (url.searchParams.get("page_standings") ? `?page_standings=${parseInt(url.searchParams.get("page_standings"), 10) || 1}` : "") : "";
    const target = FPL + path + qs;
    const cache = caches.default;
    const key = new Request(target, { method: "GET" });
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(target, { headers: { "User-Agent": "FPL-Radar/1.0 (+https://github.com/CODER1x86/fpl-radar)", "Accept": "application/json" } });
      const ct = up.headers.get("Content-Type") || "";
      if (!up.ok || !ct.includes("json")) {
        return Response.json({ error: `upstream ${up.status}`, hint: up.ok ? "FPL may be updating" : undefined }, { status: up.ok ? 503 : up.status, headers: h });
      }
      res = new Response(up.body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${route[1]}` } });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
    return out;
  },
};
