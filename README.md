# moviebay-download

Cloudflare Worker that acts as a **download rename proxy** for [Moviebay](https://moviebay.ug).

When a user taps Download, the worker fetches the video from the origin server and re-streams it with a `Content-Disposition` header that forces the browser to save the file with the **movie title as the filename** — instead of a hashed CDN name.

---

## Free tier

Cloudflare Workers free plan gives you **100,000 requests per day** — more than enough for a movie streaming site.

---

## How it works

```
Browser → https://moviebay-download.YOUR-NAME.workers.dev?url=CDN_URL&name=The+Dark+Knight+%282024%29.mp4
       → Worker fetches the file from the CDN
       → Returns it with Content-Disposition: attachment; filename="The Dark Knight (2024).mp4"
       → Browser saves: The Dark Knight (2024).mp4 ✅
```

---

## Deploy

### Option A — Cloudflare Dashboard (easiest)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create Worker**
2. Name it `moviebay-download`
3. Paste the contents of `download-worker.js` into the editor
4. Click **Deploy**

### Option B — GitHub → Cloudflare (auto-deploy on push)

1. Fork or clone this repo on GitHub
2. Go to Cloudflare → **Workers & Pages** → **Create** → **Connect to Git**
3. Select this repo
4. Set **Build command** to *(leave empty)*
5. Set **Entry point** to `download-worker.js`
6. Deploy — Cloudflare will auto-deploy on every push 🚀

---

## Connect to Moviebay frontend

After deploying, copy your Worker URL (e.g. `https://moviebay-download.YOUR-NAME.workers.dev`) and paste it into:

```
moviebay/templates/src/components/MovieModal.tsx
```

Find this line:

```typescript
const CLOUDFLARE_WORKER_URL = "";  // ← PASTE YOUR WORKER URL HERE
```

Then rebuild and deploy your frontend.
