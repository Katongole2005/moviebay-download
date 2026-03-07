/**
 * Moviebay Download Rename Proxy — Cloudflare Worker
 * ---------------------------------------------------
 * Routes:
 *   GET /?url=<encoded_url>&name=<encoded_filename>
 *
 * The worker fetches the video from the origin server and re-streams it
 * with a Content-Disposition header that forces the browser to save the
 * file under the name YOU choose (e.g. "The Dark Knight (2008).mp4").
 *
 * Free tier: 100 000 requests / day — more than enough for a movie site.
 *
 * Deploy steps (see README below):
 *   1. Sign up at https://dash.cloudflare.com (free account)
 *   2. Go to Workers & Pages → Create Worker
 *   3. Paste this entire file into the online editor
 *   4. Click "Deploy"
 *   5. Copy the worker URL (e.g. https://download.YOUR-NAME.workers.dev)
 *   6. Set WORKER_URL in MovieModal.tsx to that URL
 */

export default {
    async fetch(request, env, ctx) {
        // ── CORS pre-flight ────────────────────────────────────────────────────
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(),
            });
        }

        const { searchParams } = new URL(request.url);
        const targetUrl = searchParams.get("url");
        const filename = searchParams.get("name") || "download.mp4";

        // Basic validation
        if (!targetUrl) {
            return new Response(JSON.stringify({ error: "Missing ?url parameter" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
        }

        // Only allow http/https schemes — block file:// etc.
        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return new Response(JSON.stringify({ error: "Invalid URL" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return new Response(JSON.stringify({ error: "Disallowed protocol" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
        }

        // ── Fetch from origin ──────────────────────────────────────────────────
        let originResponse;
        try {
            originResponse = await fetch(targetUrl, {
                method: "GET",
                headers: {
                    // Mimic a real browser so PHP servers don't reject the request
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Referer": parsed.origin + "/",
                },
                redirect: "follow",
            });
        } catch (err) {
            return new Response(
                JSON.stringify({ error: "Failed to reach origin", detail: String(err) }),
                {
                    status: 502,
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                }
            );
        }

        if (!originResponse.ok) {
            return new Response(
                JSON.stringify({ error: `Origin returned ${originResponse.status}` }),
                {
                    status: originResponse.status,
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                }
            );
        }

        // ── Re-stream with download headers ───────────────────────────────────
        const contentType =
            originResponse.headers.get("content-type") || "video/mp4";

        // Sanitise filename for Content-Disposition header
        const safeFilename = filename
            .replace(/["\\\r\n]/g, "")  // strip chars illegal in quoted header value
            .slice(0, 200);             // keep it reasonable length

        const headers = {
            "Content-Type": contentType,
            // Forces browser to download rather than play inline
            "Content-Disposition": `attachment; filename="${safeFilename}"`,
            // Pass through content-length if present (helps progress bars)
            ...(originResponse.headers.get("content-length")
                ? { "Content-Length": originResponse.headers.get("content-length") }
                : {}),
            ...corsHeaders(),
        };

        return new Response(originResponse.body, { status: 200, headers });
    },
};

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}
