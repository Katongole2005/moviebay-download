/**
 * Moviebay Download / Playback Proxy — Cloudflare Worker
 * ---------------------------------------------------
 * Routes:
 *   GET /?url=<encoded_url>&name=<encoded_filename>[&play=1]
 *
 * Support for both Downloads (forces attachment) and Video Playback (inline + Range requests).
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
        const filename = searchParams.get("name") || "video.mp4";
        const isPlay = searchParams.get("play") === "1";

        // Basic validation
        if (!targetUrl) {
            return new Response(JSON.stringify({ error: "Missing ?url parameter" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
        }

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

        const isSizeRequest = searchParams.get("size") === "1";

        // ── Forward request headers (especially Range for streaming) ───────────
        const requestHeaders = new Headers();
        
        // Pass essential headers through
        const passHeaders = ["User-Agent", "Accept", "Accept-Language", "Range"];
        for (const h of passHeaders) {
            if (request.headers.has(h)) {
                requestHeaders.set(h, request.headers.get(h));
            }
        }
        
        if (!requestHeaders.has("User-Agent")) {
            requestHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        }
        requestHeaders.set("Referer", parsed.origin + "/");

        // ── Fetch from origin ──────────────────────────────────────────────────
        let originResponse;
        try {
            originResponse = await fetch(targetUrl, {
                method: (request.method === "HEAD" || isSizeRequest) ? "HEAD" : "GET",
                headers: requestHeaders,
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

        if (isSizeRequest) {
            return new Response(
                JSON.stringify({
                    size: originResponse.headers.get("Content-Length") || "unknown",
                    type: originResponse.headers.get("Content-Type") || "unknown"
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json", ...corsHeaders() }
                }
            );
        }

        if (!originResponse.ok && originResponse.status !== 206) {
            return new Response(
                JSON.stringify({ error: `Origin returned ${originResponse.status}` }),
                {
                    status: originResponse.status,
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                }
            );
        }

        // ── Re-stream with appropriate headers ────────────────────────────────
        const isDownload = searchParams.get("download") === "1";
        const forcePlay = isPlay && !isDownload;
        
        let contentType = originResponse.headers.get("content-type");
        // Force video/mp4 for common video extensions if missing or generic
        if (targetUrl.toLowerCase().endsWith(".mp4") || targetUrl.toLowerCase().endsWith(".m4v")) {
            if (!contentType || contentType === "application/octet-stream" || contentType === "text/plain") {
                contentType = "video/mp4";
            }
        }
        if (!contentType) contentType = "video/mp4";

        const safeFilename = filename.replace(/["\\\r\n]/g, "").slice(0, 200);
        const responseHeaders = new Headers(corsHeaders());

        responseHeaders.set("Content-Type", contentType);
        
        // Ensure we handle Range requests properly for streaming
        if (originResponse.status === 206) {
            responseHeaders.set("Accept-Ranges", "bytes");
        }

        if (forcePlay) {
            // For streaming, use 'inline'. filename is optional but can be included.
            responseHeaders.set("Content-Disposition", `inline; filename="${safeFilename}"`);
        } else {
            // For specifically requested downloads, force 'attachment'
            responseHeaders.set("Content-Disposition", `attachment; filename="${safeFilename}"`);
        }

        // Pass through essential streaming/range headers from origin
        const headersToKeep = ["Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"];
        for (const h of headersToKeep) {
            if (originResponse.headers.has(h)) {
                responseHeaders.set(h, originResponse.headers.get(h));
            }
        }

        // Security headers
        responseHeaders.set("X-Content-Type-Options", "nosniff");

        return new Response(originResponse.body, { 
            status: originResponse.status, 
            headers: responseHeaders 
        });
    },
};

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };
}
