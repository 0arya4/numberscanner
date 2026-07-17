import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 8787);
const maxRequestsPerMinute = 30;
const requestBuckets = new Map();

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

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function hasConfiguredSecret() {
  const key = process.env.RPIRAQ_API_ACCESS_KEY || "";
  return key.length > 12 && !key.startsWith("REPLACE_") && !key.startsWith("PASTE_");
}

function allowRequest(ip) {
  const now = Date.now();
  const bucket = requestBuckets.get(ip) || [];
  const active = bucket.filter((time) => now - time < 60_000);
  if (active.length >= maxRequestsPerMinute) {
    requestBuckets.set(ip, active);
    return false;
  }
  active.push(now);
  requestBuckets.set(ip, active);
  return true;
}

function readJson(request) {
  return new Promise((resolveRequest, rejectRequest) => {
    let bytes = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8_192) {
        rejectRequest(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolveRequest(JSON.parse(body || "{}"));
      } catch {
        rejectRequest(new Error("Invalid JSON body"));
      }
    });
    request.on("error", rejectRequest);
  });
}

function valueAtPath(source, path) {
  return path.split(".").reduce((value, key) => {
    if (value && typeof value === "object") return value[key];
    return undefined;
  }, source);
}

function configuredValue(source, variableName, defaults) {
  const configured = (process.env[variableName] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const paths = configured.length ? configured : defaults;
  for (const path of paths) {
    const value = valueAtPath(source, path);
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function callCompanyApi(barcode) {
  return new Promise((resolveCall, rejectCall) => {
    const endpoint = new URL(process.env.RPIRAQ_API_URL || "https://api.rpiraq.com/api/scan");
    const payload = JSON.stringify({ barcode });
    const useHttps = endpoint.protocol === "https:";
    const sendRequest = useHttps ? httpsRequest : httpRequest;
    const method = (process.env.RPIRAQ_API_METHOD || "GET").toUpperCase();
    const sendsJsonBody = method !== "GET" && method !== "HEAD";

    if (!sendsJsonBody) endpoint.searchParams.set("barcode", barcode);

    const headers = {
      Accept: "application/json",
      "api-access-key": process.env.RPIRAQ_API_ACCESS_KEY
    };
    if (sendsJsonBody) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const upstreamRequest = sendRequest(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || (useHttps ? 443 : 80),
        path: endpoint.pathname + endpoint.search,
        method,
        headers,
        timeout: 8_000
      },
      (upstreamResponse) => {
        let responseBody = "";
        upstreamResponse.setEncoding("utf8");
        upstreamResponse.on("data", (chunk) => {
          responseBody += chunk;
        });
        upstreamResponse.on("end", () => {
          if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
            rejectCall(new Error("Company API responded with " + upstreamResponse.statusCode));
            return;
          }
          try {
            resolveCall(JSON.parse(responseBody));
          } catch {
            rejectCall(new Error("Company API did not return JSON"));
          }
        });
      }
    );

    upstreamRequest.on("timeout", () => {
      upstreamRequest.destroy(new Error("Company API timed out"));
    });
    upstreamRequest.on("error", rejectCall);
    if (sendsJsonBody) upstreamRequest.write(payload);
    upstreamRequest.end();
  });
}

async function lookupBarcode(request, response) {
  const ip = request.socket.remoteAddress || "unknown";
  if (!allowRequest(ip)) {
    json(response, 429, { error: "Too many lookup attempts. Please wait a minute." });
    return;
  }

  if (!hasConfiguredSecret()) {
    json(response, 503, { error: "Lookup server needs a rotated API key in .env." });
    return;
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (error) {
    json(response, 400, { error: error.message });
    return;
  }

  const barcode = String(payload.barcode || "").trim();
  if (!/^\d{4,12}$/.test(barcode)) {
    json(response, 400, { error: "Enter a valid 4 to 12 digit barcode." });
    return;
  }

  try {
    const upstreamData = await callCompanyApi(barcode);
    const record = upstreamData.data || upstreamData.result || upstreamData;
    const phone = configuredValue(record, "RPIRAQ_PHONE_FIELD", [
      "phone",
      "phone_number",
      "customer_phone",
      "customer.phone"
    ]);
    const location = configuredValue(record, "RPIRAQ_LOCATION_FIELD", [
      "location",
      "address",
      "area",
      "district",
      "order.info.additional_location",
      "order.info.address.name",
      "customer.location"
    ]);
    const city = configuredValue(record, "RPIRAQ_CITY_FIELD", [
      "city",
      "order.city",
      "order.info.city",
      "order.info.address.city.name"
    ]);

    if (!phone) {
      json(response, 502, { error: "The API response does not match the configured phone field." });
      return;
    }

    json(response, 200, { barcode, phone, city, location });
  } catch (error) {
    console.error("Lookup failed:", error.message);
    json(response, 502, { error: "Lookup service is unavailable. Please try again." });
  }
}

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

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600"
    });
    response.end();
    return;
  }

  if (url.pathname === "/api/lookup") {
    if (request.method !== "POST") {
      json(response, 405, { error: "Use POST for lookups." });
      return;
    }
    await lookupBarcode(request, response);
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
