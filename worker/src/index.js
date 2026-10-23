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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin, env);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
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
