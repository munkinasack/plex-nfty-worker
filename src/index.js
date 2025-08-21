// Cloudflare Worker: Plex → ntfy with thumbnail support
// - Parses Plex webhook (multipart: payload JSON + JPEG thumb)
// - Filters by Account.title == ALLOWED_USER (case-insensitive)
// - Caches JPEG in KV with TTL and exposes it at /thumb/:id
// - Publishes JSON to ntfy root with { topic, title, message, tags, attach }

interface Env {
  THUMBS: KVNamespace;
  ALLOWED_USER?: string;
  NTFY_BASE?: string; // e.g. https://ntfy.sh or https://ntfy.example.com
  NTFY_TOPIC?: string; // e.g. mytopic
  // Classic worker secret (optional fallback)
  NTFY_TOKEN?: string;
  // Secrets Store binding (preferred)
  NTFY_TOKEN_S?: { get: () => Promise<string> };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/thumb/")) {
      return serveThumb(url.pathname.split("/thumb/")[1], env);
    }

    if (request.method !== "POST") {
      return new Response("Use POST for Plex webhooks", { status: 405 });
    }

    try {
      const { payload, thumb } = await parsePlexWebhook(request);
      if (!payload) return new Response("No payload", { status: 400 });

      // Filter by Plex Account.title
      const allowed = (env.ALLOWED_USER || "").trim().toLowerCase();
      const who = (payload?.Account?.title || "").trim().toLowerCase();
      if (allowed && who !== allowed) {
        // Silently accept but no notify
        return new Response("ignored (user filter)", { status: 204 });
      }

      // Compute message bits
      const { title, message, tags } = formatPlex(payload);

      // Cache thumbnail (if present) in KV for ~3h (matches ntfy default attachment TTL)
      let attachUrl: string | undefined;
      if (thumb) {
        const bytes = new Uint8Array(await thumb.arrayBuffer());
        const id = crypto.randomUUID();
        await env.THUMBS.put(`thumb:${id}`, bytes, { expirationTtl: 3 * 60 * 60 });
        attachUrl = new URL(`/thumb/${id}`, request.url).toString();
      }

      // Publish to ntfy (JSON mode posts to server root, not /topic)
      const ntfyBase = (env.NTFY_BASE || "").replace(/\/$/, "");
      const topic = env.NTFY_TOPIC || "";
      if (!ntfyBase || !topic) {
        return new Response("Missing NTFY_BASE or NTFY_TOPIC", { status: 500 });
      }

      const token = await getToken(env);
      const body: Record<string, unknown> = {
        topic,
        title,
        message,
        tags,
      };
      if (attachUrl) body.attach = attachUrl;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const publish = await fetch(ntfyBase, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!publish.ok) {
        const text = await publish.text();
        return new Response(`ntfy publish failed: ${publish.status} ${text}`, { status: 502 });
      }

      return new Response("ok", { status: 200 });
    } catch (err: any) {
      return new Response(`error: ${err?.message || err}`, { status: 500 });
    }
  },
};

async function getToken(env: Env): Promise<string | undefined> {
  // Prefer Secrets Store binding; fallback to classic Worker secret if present
  try {
    if (env.NTFY_TOKEN_S && typeof env.NTFY_TOKEN_S.get === "function") {
      const v = (await env.NTFY_TOKEN_S.get())?.trim();
      if (v) return v;
    }
  } catch {}
  const v = (env.NTFY_TOKEN || "").trim();
  return v || undefined;
}

async function serveThumb(id: string, env: Env): Promise<Response> {
  if (!id) return new Response("Missing id", { status: 400 });
  const buf = await env.THUMBS.get(`thumb:${id}`, { type: "arrayBuffer" });
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(buf, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=10800",
    },
  });
}

async function parsePlexWebhook(req: Request): Promise<{ payload: any | null; thumb?: File }>
{
  const ct = req.headers.get("content-type") || "";
  // Plex sends multipart/form-data with `payload` (JSON) and an attached JPEG
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const p = form.get("payload");
    const t = form.get("thumb");
    const json = await toJson(p);
    const file = t instanceof File ? t : undefined;
    return { payload: json, thumb: file };
  }
  // Fallback: raw JSON
  try {
    const json = await req.json();
    return { payload: json || null };
  } catch {
    return { payload: null };
  }
}

async function toJson(val: FormDataEntryValue | null): Promise<any | null> {
  if (!val) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  if (val instanceof File) {
    try { return JSON.parse(await val.text()); } catch { return null; }
  }
  return null;
}

function formatPlex(payload: any): { title: string; message: string; tags: string[] } {
  const ev: string = payload?.event || "media.play";
  const acc: string = payload?.Account?.title || "User";
  const md = payload?.Metadata || {};
  const type = md.type as string | undefined;

  const evNice =
    ev === "media.play" ? "Started" :
    ev === "media.resume" ? "Resumed" :
    ev === "media.pause" ? "Paused" :
    ev === "media.scrobble" ? "Finished" :
    ev === "media.rate" ? "Rated" :
    ev.replace(/^media\./, "");

  let line = "";
  if (type === "movie") {
    const title = md.title || "Movie";
    const year = md.year ? ` (${md.year})` : "";
    line = `${title}${year}`;
  } else if (type === "episode") {
    const s = md.parentIndex, e = md.index;
    const show = md.grandparentTitle || md.title || "Episode";
    const ep = md.title ? ` — \"${md.title}\"` : "";
    line = `${show} S${pad2(s)}E${pad2(e)}${ep}`;
  } else if (type === "track") {
    const track = md.title || "Track";
    const artist = md.grandparentTitle ? ` — ${md.grandparentTitle}` : "";
    line = `${track}${artist}`;
  } else {
    line = md.title || md.grandparentTitle || md.librarySectionTitle || "Media";
  }

  const player = payload?.Player?.title ? ` on ${payload.Player.title}` : "";
  const where = payload?.Player?.publicAddress ? ` (${payload.Player.publicAddress})` : "";

  return {
    title: `Plex: ${evNice}`,
    message: `${line}\nby ${acc}${player}${where}`.trim(),
    tags: ["plex", evNice.toLowerCase()],
  };
}

function pad2(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  return n < 10 ? `0${n}` : String(n);
}
