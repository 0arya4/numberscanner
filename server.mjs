import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lookupHandler from "./api/lookup.mjs";

const rootDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 8787);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(rootDirectory, "." + requestedPath);
  if (!filePath.startsWith(rootDirectory)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/api/lookup") {
    await lookupHandler(request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405);
    response.end();
    return;
  }
  await serveStatic(request, response, url.pathname);
}).listen(port, "127.0.0.1", () => {
  console.log("Secure local scanner: http://127.0.0.1:" + port);
});
