/**
 * Moviebay Download / Playback Proxy — Cloudflare Worker
 * ---------------------------------------------------
 * Routes:
 *   GET /?token=<secure_token>[&play=1]
 *   GET /?url=<encoded_url>&name=<encoded_filename>[&play=1] (Legacy)
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
        const token = searchParams.get("token");
        let targetUrl = searchParams.get("url");
        let filename = searchParams.get("name") || "video.mp4";
        const isPlay = searchParams.get("play") === "1";
        const isSizeRequest = searchParams.get("size") === "1";

        // ── Secure Token Decryption ──────────────────────────────────────────
        if (token) {
            const secret = env.ENCRYPTION_KEY;
            if (!secret) {
                return new Response(JSON.stringify({ error: "Encryption key not configured on worker" }), {
                    status: 500,
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                });
            }

            const decrypted = await decryptToken(token, secret);
            if (!decrypted) {
                return new Response(JSON.stringify({ error: "Invalid or tampered token" }), {
                    status: 403,
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                });
            }

            // Expiration Check
            if (decrypted.e < Date.now()) {
                return new Response(JSON.stringify({ error: "Link expired" }), {
                    status: 403,
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                });
            }

            targetUrl = decrypted.u;
            if (decrypted.t) filename = decrypted.t;

            // Handle spaces/special chars in the target URL
            if (targetUrl && (targetUrl.includes(" ") || /[^a-z0-9:/?&.=%[\]()-]/i.test(targetUrl))) {
                try {
                    // Try to fix common encoding issues while preserving existing valid encodings
                    const decoded = decodeURI(targetUrl);
                    const urlObj = new URL(decoded);
                    targetUrl = urlObj.toString();
                } catch (e) {
                    // Fallback to manual encodeURI if URL constructor fails
                    targetUrl = encodeURI(targetUrl).replace(/%25/g, "%");
                }
            }
        }

        // Basic validation
        if (!targetUrl) {
            return new Response(JSON.stringify({ error: "Missing source URL" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
        }

        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return new Response(JSON.stringify({ error: "Invalid source URL" }), {
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

        // Try to be more convincing to origin servers
        try {
            const originUrl = new URL(targetUrl);
            const targetOrigin = originUrl.origin;
            
            // For BunnyCDN and similar, matching the origin is usually enough
            requestHeaders.set("Referer", targetOrigin + "/");
            requestHeaders.set("Origin", targetOrigin);
        } catch (e) {
            requestHeaders.set("Referer", "https://mobifliks.com/");
            requestHeaders.set("Origin", "https://mobifliks.com");
        }

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
                JSON.stringify({ error: "Worker failed to connect to movie server", detail: String(err) }),
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
        const lowerUrl = targetUrl.toLowerCase();
        
        // Smarter Content-Type detection
        if (lowerUrl.endsWith(".mp4") || lowerUrl.endsWith(".m4v")) {
            contentType = "video/mp4";
        } else if (lowerUrl.endsWith(".mkv")) {
            contentType = "video/x-matroska";
        } else if (lowerUrl.endsWith(".webm")) {
            contentType = "video/webm";
        } else if (lowerUrl.endsWith(".mov")) {
            contentType = "video/quicktime";
        } else if (!contentType || contentType === "application/octet-stream" || contentType === "text/plain") {
            contentType = "video/mp4"; // Default fallback
        }

        const safeFilename = filename.replace(/["\\\r\n]/g, "").slice(0, 200);
        const responseHeaders = new Headers(corsHeaders());

        responseHeaders.set("Content-Type", contentType);
        responseHeaders.set("Accept-Ranges", "bytes");

        if (forcePlay) {
            responseHeaders.set("Content-Disposition", `inline; filename="${safeFilename}"`);
        } else {
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

/**
 * Decrypts the secure AES-GCM token using the shared secret.
 */
async function decryptToken(token, secret) {
    try {
        // Restore Base64 padding if removed by URL-safe conversion
        const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
        const [ivB64, encB64] = b64.split('.');
        
        if (!ivB64 || !encB64) return null;

        const addPadding = (str) => str.padEnd(str.length + (4 - str.length % 4) % 4, '=');

        const iv = new Uint8Array(atob(addPadding(ivB64)).split('').map(c => c.charCodeAt(0)));
        const encrypted = new Uint8Array(atob(addPadding(encB64)).split('').map(c => c.charCodeAt(0)));

        const encoder = new TextEncoder();
        const keyBytes = encoder.encode(secret.padEnd(32, '0').slice(0, 32));
        
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            keyBytes,
            { name: "AES-GCM" },
            false,
            ["decrypt"]
        );

        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            keyMaterial,
            encrypted
        );

        const payload = new TextDecoder().decode(decryptedBuffer);
        return JSON.parse(payload);
    } catch (err) {
        console.error("Decryption failed:", err);
        return null;
    }
}

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };
}
