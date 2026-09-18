/**
 * Cloudflare Worker: stream Google Drive files with Range support + CORS.
 *
 * Bind secrets/vars:
 *   GOOGLE_API_KEY — API key allowed to read link-shared files
 *   CORS_ORIGIN    — e.g. https://you.github.io (or *)
 *
 * Route: GET /:fileId
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true }, env, request);
    }

    const fileId = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] || "");
    if (!fileId) {
      return json({ error: "missing file id" }, env, request, 400);
    }

    const key = env.GOOGLE_API_KEY;
    if (!key) {
      return json({ error: "GOOGLE_API_KEY not configured" }, env, request, 500);
    }

    const range = request.headers.get("Range");
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(key)}`;
    const upstream = await fetch(driveUrl, {
      headers: range ? { Range: range } : undefined,
    });

    const headers = new Headers(upstream.headers);
    const cors = corsHeaders(env, request);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set("Accept-Ranges", "bytes");
    headers.delete("content-security-policy");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "*";
  const allowed = env.CORS_ORIGIN || "*";
  const value = allowed === "*" ? "*" : origin === allowed ? origin : allowed;
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
  };
}

function json(data, env, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(env, request),
    },
  });
}
