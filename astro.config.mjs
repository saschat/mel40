// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
          url.includes(".");
        if (req.method === "GET" && isHtml && !isAsset && url !== "/" && url !== "") {
          req.url = "/";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  site: "https://saschat.github.io/mel40/",
  base: "/mel40/",
  vite: {
    plugins: [localMedia(), spaFallback()],
  },
});
