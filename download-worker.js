/**
 * Moviebay All-in-One Cloudflare Worker
 * ─────────────────────────────────────
 * Dual-purpose worker — one deployment, two functions:
 *
 * [1] HTML Preloader (Edge HTMLRewriter)
 *     Intercepts HTML page navigations (Accept: text/html) coming from
 *     the main site and injects <link rel="preconnect"> / <link rel="preload">
 *     tags into <head> at the edge, cutting LCP by 100-200ms globally.
 *     Reads X-Preconnect-Hosts + X-Preload-Hero headers emitted by Next.js proxy.ts.
 *
 * [2] Download / Playback Proxy
 *     Routes:
 *       GET /?token=<secure_token>[&play=1]
 *       GET /?url=<encoded_url>&name=<encoded_filename>[&play=1] (Legacy)
 *     Support for Downloads (forces attachment) and Video Playback (inline + Range).
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

        // ── [1] HTML PRELOADER — intercept page navigations ────────────────────
        // If the request accepts HTML and has NO token/url params (i.e. it's a
        // browser page navigation, not a download/playback request), run the
        // HTMLRewriter preloader and return early.
        const accept = request.headers.get("Accept") || "";
        const { searchParams } = new URL(request.url);
        const hasDownloadParams = searchParams.has("token") || searchParams.has("url");

        if (accept.includes("text/html") && !hasDownloadParams) {
            return handleHtmlPreloader(request);
        }

        const token = searchParams.get("token");
        let targetUrl = searchParams.get("url");
        let filename = searchParams.get("name") || "video.mp4";
        const isPlay = searchParams.get("play") === "1";
        const isSizeRequest = searchParams.get("size") === "1";

        // ── Secure Token Decryption & Verification ──────────────────────────
        let isTokenAuthorized = false;
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
            isTokenAuthorized = true;
        }

        // ── Hotlink Protection (CORS/Referer Check) ──────────────────────────
        // Skip hotlink checks if the request has been fully authorized by a secure token.
        if (!isTokenAuthorized) {
            const origin = request.headers.get("Origin") || "";
            const referer = request.headers.get("Referer") || "";
            
            // Allowed domains for playback/download
            const allowedDomains = [
                "s-u.in",
                "www.s-u.in",
                "localhost",
                "127.0.0.1",
                "moviebay.vercel.app" // In case you use the vercel domain
            ];

            const isAllowedOrigin = (urlStr) => {
                if (!urlStr) return false;
                try {
                    const url = new URL(urlStr);
                    return allowedDomains.some(domain => 
                        url.hostname === domain || url.hostname.endsWith(`.${domain}`)
                    );
                } catch (e) {
                    return false;
                }
            };

            const hasValidOrigin = isAllowedOrigin(origin);
            const hasValidReferer = isAllowedOrigin(referer);

            if (origin || referer) {
                if (!hasValidOrigin && !hasValidReferer) {
                    return new Response(JSON.stringify({ error: "Hotlinking restricted. Please watch on the official site." }), {
                        status: 403,
                        headers: { "Content-Type": "application/json", ...corsHeaders() },
                    });
                }
            } else {
                // Strictly block direct raw access if it's not a size request
                if (!isSizeRequest) {
                    return new Response(JSON.stringify({ error: "Direct access disabled or missing secure token. Please watch on the official site." }), {
                        status: 403,
                        headers: { "Content-Type": "application/json", ...corsHeaders() },
                    });
                }
            }
        }

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

        // Basic validation
        if (!targetUrl) {
            return new Response(JSON.stringify({ error: isSizeRequest ? "Missing target URL" : "Failed to extract source URL from token" }), {
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
        
        requestHeaders.set("Accept-Encoding", "identity");

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
            // Append a cache-buster query parameter to ensure Cloudflare edge cache bypass
            // and preserve Range headers for streaming without throwing platform TypeErrors.
            const cb = `_cb=${Date.now()}`;
            const busterUrl = targetUrl.includes("?") ? `${targetUrl}&${cb}` : `${targetUrl}?${cb}`;

            originResponse = await fetch(busterUrl, {
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

        if (isDownload) {
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

/**
 * [1] HTML Preloader — Edge HTMLRewriter
 * ─────────────────────────────────────────────────────────────────────────────
 * Intercepts HTML page navigations, reads X-Preconnect-Hosts and X-Preload-Hero
 * headers set by Next.js proxy.ts, and uses HTMLRewriter to inject
 * <link rel="preconnect"> / <link rel="preload"> tags into <head>.
 *
 * This means the browser starts DNS/TCP/TLS handshakes to your image CDNs
 * at the very first byte of HTML — before any JS bundle loads.
 */
async function handleHtmlPreloader(request) {
    // Fetch the HTML from the origin (your Vercel / Next.js deployment)
    const originResponse = await fetch(request);

    // Only process HTML responses — pass everything else straight through
    const contentType = originResponse.headers.get("Content-Type") || "";
    if (!contentType.includes("text/html")) {
        return originResponse;
    }

    // Read the custom headers emitted by Next.js proxy.ts
    const heroImageUrl    = originResponse.headers.get("X-Preload-Hero");
    const heroPosterUrl   = originResponse.headers.get("X-Preload-Hero-Poster");
    const preconnectHosts = originResponse.headers.get("X-Preconnect-Hosts");

    // Nothing to inject? Serve as-is.
    if (!heroImageUrl && !heroPosterUrl && !preconnectHosts) {
        return originResponse;
    }

    // Use HTMLRewriter to inject tags into <head>
    const rewriter = new HTMLRewriter().on("head", {
        element(head) {
            // 1. Preconnect + optional preload for hero backdrop image
            if (heroImageUrl) {
                try {
                    const parsed = new URL(heroImageUrl);
                    // Always preconnect to TMDB CDN
                    head.prepend(
                        `<link rel="preconnect" href="${parsed.origin}" crossorigin>`,
                        { html: true }
                    );
                    // Only inject full <link rel="preload"> for real image paths
                    const hasRealPath = parsed.pathname.length > 10 && !parsed.pathname.endsWith("/");
                    if (hasRealPath) {
                        head.prepend(
                            `<link rel="preload" as="image" href="${heroImageUrl}" fetchpriority="high">`,
                            { html: true }
                        );
                    }
                } catch (_) {}
            }

            // 2. Preload for hero poster / mobile fallback
            if (heroPosterUrl) {
                try {
                    head.prepend(
                        `<link rel="preload" as="image" href="${heroPosterUrl}">`,
                        { html: true }
                    );
                } catch (_) {}
            }

            // 3. Preconnect for all CDN / API hosts
            if (preconnectHosts) {
                const hosts = preconnectHosts.split(",").map((h) => h.trim()).filter(Boolean);
                for (const host of hosts) {
                    try {
                        new URL(host); // validate it's a real URL
                        head.prepend(
                            `<link rel="preconnect" href="${host}" crossorigin>`,
                            { html: true }
                        );
                    } catch (_) {}
                }
            }
        },
    });

    // Strip the internal X- headers before sending to the browser
    const newHeaders = new Headers(originResponse.headers);
    newHeaders.delete("X-Preload-Hero");
    newHeaders.delete("X-Preload-Hero-Poster");
    newHeaders.delete("X-Preconnect-Hosts");

    return rewriter.transform(
        new Response(originResponse.body, {
            status: originResponse.status,
            statusText: originResponse.statusText,
            headers: newHeaders,
        })
    );
}
