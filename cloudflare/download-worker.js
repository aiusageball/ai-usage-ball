const DMG = "https://github.com/aiusageball/ai-usage-ball/releases/latest/download/AI-Usage-Ball-site.dmg";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/download/stats") {
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "90", 10) || 90, 1), 366);
      const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const byRef = {}, byDay = {};
      const keys = [];
      let total = 0, cursor;
      do {
        const r = await env.DL.list({ prefix: "c:", cursor });
        for (const k of r.keys) {
          const [, day, ref] = k.name.split(":");
          if (day >= since) keys.push({ name: k.name, day, ref });
        }
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
      for (let i = 0; i < keys.length; i += 10) {
        const batch = keys.slice(i, i + 10);
        const vals = await Promise.all(batch.map((k) => env.DL.get(k.name)));
        batch.forEach((k, idx) => {
          const n = parseInt(vals[idx] || "0", 10);
          byRef[k.ref] = (byRef[k.ref] || 0) + n;
          (byDay[k.day] ||= {})[k.ref] = n;
          total += n;
        });
      }
      return new Response(JSON.stringify({ since, total, byRef, byDay }, null, 2), {
        headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    }
    if (path !== "/download") return fetch(request);
    let ref = (url.searchParams.get("ref") || "direct").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    if (!ref) ref = "direct";
    const bot = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl\/|wget|python-requests/i.test(request.headers.get("user-agent") || "");
    if (request.method === "GET" && !bot) {
      const key = `c:${new Date().toISOString().slice(0, 10)}:${ref}`;
      ctx.waitUntil((async () => {
        const n = parseInt((await env.DL.get(key)) || "0", 10);
        await env.DL.put(key, String(n + 1));
      })());
    }
    return new Response(null, { status: 302, headers: { location: DMG, "cache-control": "no-store", "x-robots-tag": "noindex" } });
  },
};
