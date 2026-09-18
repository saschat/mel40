// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function googleApiKey() {
  if (process.env.PUBLIC_GOOGLE_API_KEY) return process.env.PUBLIC_GOOGLE_API_KEY;
  const env = loadEnv("development", rootDir, "");
  return env.PUBLIC_GOOGLE_API_KEY || "";
}
/**
 * Serve local encodes in `astro dev` (no public/ symlinks).
 * Supports HTTP Range so <video> seeking works.
 */
function localMedia() {
  /** @type {Record<string, string>} */
  const mounts = {
    "/media-mobile": path.join(rootDir, "videos/normalized_mobile"),
    "/media-hd": path.join(rootDir, "videos/normalized"),
    "/media": path.join(rootDir, "videos/normalized_mobile"),
  };

  return {
    name: "mel40-local-media",
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = req.url?.split("?")[0] ?? "";
        let dir = null;
        let prefix = null;
        for (const [p, d] of Object.entries(mounts)) {
          if (urlPath.startsWith(p + "/") || urlPath === p) {
            prefix = p;
            dir = d;
            break;
          }
        }
        if (!dir || !prefix) return next();

        const rel = decodeURIComponent(urlPath.slice(prefix.length).replace(/^\/+/, ""));
        if (!rel || rel.includes("..")) {
          res.statusCode = 400;
          res.end("bad path");
          return;
        }
        const file = path.join(dir, rel);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }

        const stat = fs.statSync(file);
        const size = stat.size;
        const range = req.headers.range;
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-cache");

        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match) {
            res.statusCode = 416;
            res.end();
            return;
          }
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : size - 1;
          if (start >= size || end >= size || start > end) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }

        res.setHeader("Content-Length", String(size));
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/** In `astro dev`, rewrite /some-config-id → / so the client router can load. */
function spaFallback() {
  return {
    name: "mel40-spa-fallback",
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const accept = req.headers.accept ?? "";
        const isHtml = accept.includes("text/html");
        const isAsset =
          url.startsWith("/@") ||
          url.startsWith("/src/") ||
          url.startsWith("/node_modules/") ||
          url.startsWith("/media/") ||
          url.startsWith("/media-mobile/") ||
          url.startsWith("/media-hd/") ||
          url.startsWith("/configs/") ||
          url.startsWith("/api/") ||
          url.includes(".");
        if (req.method === "GET" && isHtml && !isAsset && url !== "/" && url !== "") {
          req.url = "/";
        }
        next();
      });
    },
  };
}

/**
 * Same-origin Drive proxy for `astro dev` — avoids browser CORS and keeps the
 * website-restricted API key happy by forwarding a localhost Referer.
 */
function driveDevProxy() {
  return {
    name: "mel40-drive-dev-proxy",
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = req.url?.split("?")[0] ?? "";
        const match = /^\/api\/drive\/([^/]+)\/?$/.exec(urlPath);
        if (!match) return next();
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }

        const key = googleApiKey();
        if (!key) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "PUBLIC_GOOGLE_API_KEY missing in .env" }));
          return;
        }

        const fileId = decodeURIComponent(match[1] ?? "");
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(key)}`;
        /** @type {Record<string, string>} */
        const headers = {
          // Website-restricted keys check Referer on the Google request.
          Referer: req.headers.referer || "http://localhost:4321/",
        };
        if (req.headers.range) headers.Range = String(req.headers.range);

        try {
          const upstream = await fetch(driveUrl, { headers, method: req.method });
          res.statusCode = upstream.status;
          const pass = [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
            "cache-control",
          ];
          for (const name of pass) {
            const v = upstream.headers.get(name);
            if (v) res.setHeader(name, v);
          }
          res.setHeader("Accept-Ranges", "bytes");
          if (req.method === "HEAD" || !upstream.body) {
            res.end();
            return;
          }
          const { Readable } = await import("node:stream");
          Readable.fromWeb(/** @type {any} */ (upstream.body)).pipe(res);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

const isPages = process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  site: isPages ? "https://saschat.github.io/mel40/" : undefined,
  base: isPages ? "/mel40/" : "/",
  vite: {
    plugins: [localMedia(), driveDevProxy(), spaFallback()],
  },
});
