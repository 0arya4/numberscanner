const maxRequestsPerMinute = 30;
const requestBuckets = new Map();

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function hasConfiguredSecret() {
  const key = process.env.RPIRAQ_API_ACCESS_KEY || "";
  return key.length > 12 && !key.startsWith("REPLACE_") && !key.startsWith("PASTE_");
}

function requestIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return request.socket?.remoteAddress || "unknown";
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

async function readPayload(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
    return JSON.parse(String(request.body) || "{}");
  }

  let bytes = 0;
  let body = "";
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8_192) throw new Error("Request body is too large");
    body += chunk;
  }
  return JSON.parse(body || "{}");
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

async function callCompanyApi(barcode) {
  const endpoint = new URL(process.env.RPIRAQ_API_URL || "https://api.rpiraq.com/api/scan");
  const method = (process.env.RPIRAQ_API_METHOD || "GET").toUpperCase();
  const sendsJsonBody = method !== "GET" && method !== "HEAD";
  const payload = JSON.stringify({ barcode });
  if (!sendsJsonBody) endpoint.searchParams.set("barcode", barcode);

  const headers = {
    Accept: "application/json",
    "api-access-key": process.env.RPIRAQ_API_ACCESS_KEY
  };
  if (sendsJsonBody) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const upstreamResponse = await fetch(endpoint, {
      method,
      headers,
      body: sendsJsonBody ? payload : undefined,
      signal: controller.signal
    });
    if (!upstreamResponse.ok) {
      throw new Error("Company API responded with " + upstreamResponse.status);
    }
    return await upstreamResponse.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(request, response) {
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Max-Age", "600");
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Use POST for lookups." });
    return;
  }

  if (!allowRequest(requestIp(request))) {
    sendJson(response, 429, { error: "Too many lookup attempts. Please wait a minute." });
    return;
  }

  if (!hasConfiguredSecret()) {
    sendJson(response, 503, { error: "Lookup server needs RPIRAQ_API_ACCESS_KEY." });
    return;
  }

  let payload;
  try {
    payload = await readPayload(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message || "Invalid JSON body" });
    return;
  }

  const barcode = String(payload.barcode || "").trim();
  if (!/^\d{4,12}$/.test(barcode)) {
    sendJson(response, 400, { error: "Enter a valid 4 to 12 digit ID." });
    return;
  }

  try {
    const upstreamData = await callCompanyApi(barcode);
    const record = upstreamData.data || upstreamData.result || upstreamData;
    const phone = configuredValue(record, "RPIRAQ_PHONE_FIELD", [
      "order.receiver.phone",
      "phone",
      "phone_number",
      "customer_phone",
      "customer.phone"
    ]);
    const location = configuredValue(record, "RPIRAQ_LOCATION_FIELD", [
      "order.info.additional_location",
      "order.info.address.name",
      "location",
      "address",
      "area",
      "district",
      "customer.location"
    ]);
    const city = configuredValue(record, "RPIRAQ_CITY_FIELD", [
      "order.info.address.city.name",
      "city",
      "order.city",
      "order.info.city"
    ]);

    if (!phone) {
      sendJson(response, 502, { error: "The API response does not match the configured phone field." });
      return;
    }

    sendJson(response, 200, { barcode, phone, city, location });
  } catch (error) {
    console.error("Lookup failed:", error.message);
    sendJson(response, 502, { error: "Lookup service is unavailable. Please try again." });
  }
}
