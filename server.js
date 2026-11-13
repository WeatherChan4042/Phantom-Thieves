// LINAW server: serves the Main/ folder and talks to Lumen on the browser's behalf.
// The Lumen credentials are read from .env here and never reach the browser.
// API reference: the competition's ocr-openapi.yaml and ai-chat-openapi.yaml.
// Run with: node server.js   (Node 20.12+)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  console.warn("No .env file found. Lumen requests will be refused until it exists.");
}

const PORT = Number(process.env.PORT) || 3000;
const WEB_ROOT = path.join(__dirname, "Main");

// Limits from the OCR spec: 10 MiB cap. LINAW accepts the PDF/PNG/JPEG subset.
const OCR_MAX_BYTES = 10 * 1024 * 1024;
const OCR_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);
const OCR_POLL_MS = 2000;
const OCR_MAX_WAIT_MS = 90000;
// Chat spec: message is 1 to 4000 characters. Each turn may take up to 25 s.
const CHAT_MAX_CHARS = 4000;
const CHAT_MAX_BODY = 64 * 1024;

// The chat instance is blank ("teams set behavior in their own messages"), so every
// message starts with this short brief. The transcript keeps earlier turns for context.
const CHAT_BRIEF =
  "You are LINAW, a friendly assistant in a Filipino personal document journal app. " +
  "Help with everyday documents such as bills, receipts, school and government forms, " +
  "and follow-up requests about earlier answers in this conversation (for example rephrasing or translating). " +
  "Answer in the user's language (English or Filipino). Keep answers short and clear. " +
  "Do not give legal, medical, or financial advice.\n\nUser message: ";

// ---------- Lumen client (server only) ----------

class LumenFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function lumenConfig(kind) {
  const key = process.env.LUMEN_API_KEY;
  const secret = process.env.LUMEN_API_SECRET;
  const base = kind === "ocr" ? process.env.LUMEN_OCR_URL : process.env.LUMEN_CHAT_URL;
  if (!key || !secret || !base) {
    throw new LumenFailure(503, "NOT_CONFIGURED", "Lumen is not connected yet. Add the credentials and URLs to .env, then restart the server.");
  }
  return { base: base.replace(/\/+$/, ""), headers: { "lumen-api-key": key, "lumen-api-secret": secret } };
}

// Call one Lumen endpoint and return the parsed JSON body. Errors use the spec's
// { error: { code, message } } envelope. Credentials are never logged or returned.
async function lumenFetch(kind, route, { method = "GET", headers = {}, body, timeoutMs = 30000 } = {}) {
  const { base, headers: auth } = lumenConfig(kind);
  let response;
  try {
    response = await fetch(base + route, {
      method,
      headers: { ...auth, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new LumenFailure(504, "TIMEOUT", "Lumen took too long to answer. Please try again.");
    throw new LumenFailure(502, "UNREACHABLE", "Could not reach Lumen. Check your internet connection.");
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!response.ok) {
    const code = data?.error?.code || `HTTP_${response.status}`;
    console.warn(`Lumen ${kind} ${method} ${route.replace(/[0-9a-f-]{36}/gi, ":id")} -> ${response.status} ${code}`);
    throw new LumenFailure(response.status, code, friendlyMessage(response.status, code));
  }
  return data;
}

// Plain-language messages for the error codes listed in the specs.
function friendlyMessage(status, code) {
  const byCode = {
    API_KEY_NOT_FOUND: "Lumen did not recognise the API key. Check LUMEN_API_KEY in .env.",
    API_SECRET_NOT_FOUND: "Lumen did not recognise the API secret. Check LUMEN_API_SECRET in .env.",
    INVALID_API_CREDENTIALS: "Lumen rejected the API credentials. Check .env.",
    ACCESS_DENIED: "This API key is not allowed to use this Lumen feature.",
    VIEW_ONLY_ACCESS: "This API key is read-only, so it cannot send this request.",
    ORG_SUBSCRIPTION_INACTIVE: "Your organization's Lumen subscription is inactive.",
    API_CREDITS_INSUFFICIENT: "Your team is out of Lumen API credits.",
    LC_INSUFFICIENT: "Your team is out of Lumen Credits.",
    RATE_LIMIT_EXCEEDED: "Too many requests. Please wait a moment and try again.",
    BURST_RATE_LIMIT_EXCEEDED: "Too many requests at once. Please wait a moment and try again.",
    AI_CHAT_MODEL_RATE_LIMITED: "The assistant is busy. Please wait a moment and try again.",
    AI_CHAT_QUERY_TOO_LONG: "That question is too long for the assistant.",
    AI_CHAT_QUERY_REQUIRED: "Please write a question first.",
    AI_CHAT_REPLY_TIMEOUT: "The assistant took too long to reply. Please try again.",
    AI_CHAT_MODEL_UPSTREAM_ERROR: "The assistant had a problem answering. Please try again.",
    AI_CHAT_MODEL_UNAVAILABLE: "The assistant is unavailable right now. Please try again.",
    AI_CHAT_NOT_CONFIGURED: "Lumen AI Chat is not set up in this environment.",
    OCR_NOT_CONFIGURED: "Lumen OCR is not set up in this environment.",
    OCR_READ_QUEUE_FULL: "Lumen OCR is busy right now. Please try again shortly.",
    PERMISSIONS_UPDATING: "Lumen is updating permissions. Please try again shortly.",
    FEATURE_DISABLED: "This Lumen feature is currently disabled."
  };
  if (byCode[code]) return byCode[code];
  if (status === 413) return "That file is larger than Lumen's 10 MB limit.";
  if (status === 415) return "Lumen cannot read that file type.";
  if (status === 429) return "Too many requests. Please wait a moment and try again.";
  if (status >= 500) return "Lumen is having trouble right now. Please try again.";
  return "Lumen could not complete that request.";
}

// ---------- OCR: upload, poll until READY/PARTIAL, then read the pages ----------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readDocument(bytes, mediaType, name) {
  const upload = await lumenFetch("ocr", "/documents", {
    method: "POST",
    headers: { "Content-Type": mediaType, "X-Lumen-Document-Name": encodeURIComponent(name) },
    body: bytes,
    timeoutMs: 60000
  });
  const documentId = upload?.data?.DocumentID;
  if (!documentId) throw new LumenFailure(502, "BAD_RESPONSE", "Lumen did not return a document ID.");

  let record = upload.data;
  const deadline = Date.now() + OCR_MAX_WAIT_MS;
  while (!["READY", "PARTIAL", "FAILED"].includes(record.Status)) {
    if (Date.now() > deadline) throw new LumenFailure(504, "OCR_TIMEOUT", "Lumen OCR is taking too long. Please try again.");
    await sleep(OCR_POLL_MS);
    record = (await lumenFetch("ocr", `/documents/${encodeURIComponent(documentId)}`)).data;
  }
  if (record.Status === "FAILED") {
    const reasons = {
      unsupported_media: "Lumen cannot read this kind of file.",
      corrupt_document: "The file seems to be damaged.",
      timeout: "Lumen took too long reading this file.",
      unavailable: "Lumen OCR is unavailable right now."
    };
    throw new LumenFailure(422, "OCR_FAILED", reasons[record.FailureReason] || "Lumen could not read this document.");
  }

  const pages = await lumenFetch("ocr", `/documents/${encodeURIComponent(documentId)}/pages?IncludeWords=true`);
  const items = [...(pages?.data?.Items || [])].sort((a, b) => a.PageNumber - b.PageNumber);
  const text = items
    .map(page => (page.Lines || []).map(line => line.text).filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return {
    text,
    status: record.Status,
    pageCount: record.PageCount,
    failedPages: record.FailedPageNumbers || []
  };
}

// ---------- AI Chat: one instance, one session per browser tab ----------

let instancePromise = null;

// Use LUMEN_CHAT_INSTANCE_ID if set, otherwise the first ACTIVE instance from GET /instances.
function getInstanceId() {
  if (process.env.LUMEN_CHAT_INSTANCE_ID) return Promise.resolve(process.env.LUMEN_CHAT_INSTANCE_ID);
  if (!instancePromise) {
    instancePromise = lumenFetch("chat", "/instances").then(data => {
      const instance = (data?.Instances || []).find(item => item.Status === "ACTIVE");
      if (!instance) throw new LumenFailure(503, "NO_INSTANCE", "No active Lumen AI Chat assistant is available for this key.");
      return instance.InstanceID;
    });
    instancePromise.catch(() => { instancePromise = null; });
  }
  return instancePromise;
}

async function createSession(instanceId) {
  const data = await lumenFetch("chat", `/instances/${encodeURIComponent(instanceId)}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `LINAW chat ${new Date().toISOString()}` })
  });
  const id = data?.Session?.id;
  if (!id) throw new LumenFailure(502, "BAD_RESPONSE", "Lumen did not return a chat session.");
  return id;
}

async function sendMessage(instanceId, sessionId, message) {
  const data = await lumenFetch("chat", `/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    timeoutMs: 35000 // the spec's reply deadline is 25 s
  });
  const answer = data?.Answer?.answer;
  if (typeof answer !== "string" || !answer.trim()) throw new LumenFailure(502, "EMPTY_ANSWER", "The assistant sent back an empty reply.");
  return answer.trim();
}

// The instance's own scope filter (set by org admins, not changeable through the API) sometimes
// refuses a question with this fixed reply. Rephrasing usually works, so the app shows a hint.
const OUT_OF_SCOPE_REPLY = "that question is outside what this assistant covers.";
const isOutOfScope = answer => answer.trim().toLowerCase() === OUT_OF_SCOPE_REPLY;

// Sessions that are gone, archived, or owned by another key are replaced with a new one.
const RESTART_CODES = new Set(["AI_CHAT_SESSION_NOT_FOUND", "SESSION_NOT_FOR_INSTANCE", "SESSION_NOT_OWNED", "AI_CHAT_CONFLICT", "AI_CHAT_SESSION_ID_INVALID", "AI_CHAT_BAD_REQUEST"]);

async function chat(sessionId, question) {
  const instanceId = await getInstanceId();
  // The instance judges each message on its own, so every message carries the brief.
  const message = CHAT_BRIEF + question;
  const reply = (id, answer) => ({ sessionId: id, answer, outOfScope: isOutOfScope(answer) });
  if (sessionId) {
    try {
      return reply(sessionId, await sendMessage(instanceId, sessionId, message));
    } catch (error) {
      if (!RESTART_CODES.has(error.code)) throw error;
    }
  }
  const newId = await createSession(instanceId);
  return reply(newId, await sendMessage(instanceId, newId, message));
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  if (error instanceof LumenFailure) {
    return sendJson(res, error.status, { error: { code: error.code, message: error.message } });
  }
  console.error("Unexpected server error:", error.message);
  sendJson(res, 500, { error: { code: "SERVER_ERROR", message: "Something went wrong on the LINAW server." } });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > maxBytes) return reject(new LumenFailure(413, "TOO_LARGE", "That file is larger than 10 MB."));
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new LumenFailure(413, "TOO_LARGE", "That file is larger than 10 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Check the file's first bytes so a renamed file cannot slip through.
function sniff(bytes) {
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  return null;
}

async function handleOcr(req, res) {
  const mediaType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!OCR_TYPES.has(mediaType)) {
    throw new LumenFailure(415, "UNSUPPORTED_TYPE", "Please choose a PDF, JPG, or PNG file.");
  }
  lumenConfig("ocr"); // fail fast before reading a large body
  const bytes = await readBody(req, OCR_MAX_BYTES);
  if (!bytes.length) throw new LumenFailure(400, "EMPTY_FILE", "That file is empty.");
  if (sniff(bytes) !== mediaType) throw new LumenFailure(415, "TYPE_MISMATCH", "That file's contents do not match its type.");
  let name = "document";
  try { name = decodeURIComponent(String(req.headers["x-document-name"] || "document")); } catch { /* keep default */ }
  name = name.replace(/[\u0000-\u001f]/g, "").slice(0, 256) || "document";
  sendJson(res, 200, await readDocument(bytes, mediaType, name));
}

async function handleChat(req, res) {
  lumenConfig("chat");
  let payload;
  try {
    payload = JSON.parse((await readBody(req, CHAT_MAX_BODY)).toString("utf8"));
  } catch (error) {
    if (error instanceof LumenFailure) throw error;
    throw new LumenFailure(400, "BAD_JSON", "The chat request was not valid.");
  }
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const sessionId = typeof payload?.sessionId === "string" && /^[\w-]{1,100}$/.test(payload.sessionId) ? payload.sessionId : null;
  if (!message) throw new LumenFailure(400, "AI_CHAT_QUERY_REQUIRED", "Please write a question first.");
  if (CHAT_BRIEF.length + message.length > CHAT_MAX_CHARS) {
    throw new LumenFailure(400, "AI_CHAT_QUERY_TOO_LONG", "That question is too long. Please shorten it.");
  }
  sendJson(res, 200, await chat(sessionId, message));
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon"
};

function serveStatic(req, res) {
  let requested;
  try {
    requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }
  const relative = requested === "/" ? "Phantom.html" : requested;
  const file = path.resolve(WEB_ROOT, "." + path.sep + relative);
  // Only files inside Main/ may be served. This blocks ../ tricks and keeps .env private.
  if (!file.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

const routes = {
  "POST /api/ocr": handleOcr,
  "POST /api/chat": handleChat,
  "GET /api/status": (req, res) => {
    const has = name => Boolean(process.env[name]);
    const creds = has("LUMEN_API_KEY") && has("LUMEN_API_SECRET");
    sendJson(res, 200, { ocr: creds && has("LUMEN_OCR_URL"), chat: creds && has("LUMEN_CHAT_URL") });
  }
};

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const handler = routes[`${req.method} ${pathname}`];
  if (handler) {
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
    }
    return;
  }
  if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Unknown API route." } });
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`LINAW running at http://localhost:${PORT}`));
