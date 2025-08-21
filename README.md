# Plex → ntfy: One‑Click Cloudflare Worker

A tiny Cloudflare Worker that receives Plex webhooks, filters by **one Plex user**, and forwards a pretty notification to **ntfy** — including a **thumbnail** of the media now playing. The thumbnail is cached briefly in Workers KV and exposed via a signed-ish URL the Worker serves at `/thumb/:id`, which ntfy uses as an attachment.

> Deploy it with the button below after you’ve pushed this repository to GitHub/GitLab (public). The Deploy flow will provision KV & bindings for you.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<YOUR_PUBLIC_REPO_URL>)

---

## What you get

* ✅ Filters Plex webhooks so **only events from one Plex user** trigger notifications
* 🖼️ Sends an ntfy message with **title, message, tags**, and **`attach`** pointing at the cached thumbnail
* 🔐 Uses **Cloudflare Secrets Store** for the ntfy token (or classic Worker secret as a fallback)
* 🗃️ Short‑lived thumbnails stored in **Workers KV** (default TTL: 3h)
* 🧪 Works with Plex’s standard **multipart/form-data** webhooks (payload + JPEG thumb)

---

## Files

### `wrangler.toml`

```toml
name = "plex-ntfy-worker"
main = "src/index.ts"
compatibility_date = "2025-08-20"
workers_dev = true

# Provisioned automatically by the Deploy flow; IDs will be filled in.
kv_namespaces = [
  { binding = "THUMBS" }
]

[vars]
# These are configured as Worker *secrets* post-deploy; values here are just docs.
# Run `wrangler secret put ALLOWED_USER` etc., or set them in the Dashboard.
# ALLOWED_USER = ""
# NTFY_BASE = "https://ntfy.sh"
# NTFY_TOPIC = "mytopic"

# Bind a Secrets Store secret for the ntfy token (pick your actual store & secret name in the deploy UI)
[[secrets_store_secrets]]
# Binding name available in code as env.NTFY_TOKEN_S (call .get() to retrieve)
binding = "NTFY_TOKEN_S"
# These placeholders will be replaced in the deploy UI
store_id = "demo"
secret_name = "ntfy-token"
```

### `package.json`

```json
{
  "name": "plex-ntfy-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3.95.0",
    "typescript": "^5.6.2",
    "@cloudflare/workers-types": "^4.2025.8.1"
  },
  "cloudflare": {
    "bindings": {
      "ALLOWED_USER": { "description": "Only notify for this Plex user (Account.title). Leave empty to allow all." },
      "NTFY_BASE": { "description": "Your ntfy base URL, e.g. https://ntfy.sh or https://ntfy.example.com" },
      "NTFY_TOPIC": { "description": "ntfy topic name (no slashes)" },
      "NTFY_TOKEN_S": { "description": "Secrets Store: Select the ntfy access token (Authorization: Bearer ...)" }
    }
  }
}
```

### `.dev.vars.example` (optional, for local `wrangler dev`)

```dotenv
# For local dev only (not used in production automatically)
ALLOWED_USER=
NTFY_BASE=https://ntfy.sh
NTFY_TOPIC=demo
# Optional fallback if you prefer classic Worker secrets instead of Secrets Store
NTFY_TOKEN=
```

### `src/index.ts`

```ts
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
```

---

## How to deploy

1. **Create a public repo** with these files, then click the button above (replace `<YOUR_PUBLIC_REPO_URL>` in the link).

2. In the Deploy flow:

   * Accept provisioning of **KV** for `THUMBS`.
   * Bind **Secrets Store** secret named `ntfy-token` to binding `NTFY_TOKEN_S` (or adjust names).

3. After deploy, open **Settings → Variables/Secrets** for your Worker and set:

   * `ALLOWED_USER` → your Plex user’s **Account.title** (case-insensitive). Leave empty to notify for everyone.
   * `NTFY_BASE` → e.g. `https://ntfy.sh` or your self‑hosted base URL.
   * `NTFY_TOPIC` → your topic name.
   * (Optional) `NTFY_TOKEN` as a classic secret if you prefer not to use Secrets Store.

4. In **Plex**: Settings → Webhooks → add your Worker URL (e.g., `https://<yourname>.workers.dev/`).

5. Play something as the allowed user; you should see an ntfy notification with a thumbnail.

---

## Notes & tweaks

* **Thumbnail retention**: change `expirationTtl` in `src/index.ts` (default 3 hours).
* **Icon vs. attachment**: this template uses `attach` with a public URL served by the Worker; that shows the picture inline in ntfy. If you prefer **uploading** the file directly, you could `PUT` the JPEG to `NTFY_BASE/<topic>` with `Filename:` header — but that would create a separate attachment notification.
* **Security**: If your Worker URL is public, anyone could try posting. If you want to lock it down, add a shared secret header and check it before processing.

---

## Testing locally

```bash
# 1) Install deps
npm i

# 2) (optional) create .dev.vars from the example
cp .dev.vars.example .dev.vars
# edit with your values

# 3) Run local dev
npm run dev
```

---

## License

MIT
