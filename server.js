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
// The spec allows 4000 characters per message, but the instance itself refuses anything over
// about 2000 with AI_CHAT_QUERY_TOO_LONG (measured: 1982 accepted, 2012 refused). Keep a margin.
// Each turn may take up to 25 s.
const CHAT_MAX_CHARS = 1900;
// If Lumen still says too long, retry with less document text (refusals cost no credits).
const DOC_RETRY_BUDGETS = [CHAT_MAX_CHARS, 1500, 1100];
const CHAT_MAX_BODY = 256 * 1024;
const MAX_DOC_CHARS = 50000; // document text a request may carry; only an excerpt is sent to Lumen

// The chat instance is blank ("teams set behavior in their own messages"), so every
// message starts with this brief. It is kept short because the whole message must fit the limit.
const BRIEF_CORE =
  "You are LINAW, a friendly helper for everyday documents in the Philippines (bills, receipts, school and " +
  "government forms), including follow-ups like rephrasing or translating. Reply in the user's language " +
  "(English or Filipino), short and simple. No legal, medical or financial advice.";
const CHAT_BRIEF = BRIEF_CORE + "\n\nUser message: ";

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
    AI_CHAT_QUERY_TOO_LONG: "That message is too long for Lumen's assistant. Please shorten your question.",
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
  return { ...buildText(items), status: record.Status, pageCount: record.PageCount, failedPages: record.FailedPageNumbers || [] };
}

// Words Lumen measured below this confidence are flagged for the user to check.
const UNSURE_BELOW = 0.85;
const MAX_UNSURE = 100;

// Join the recognised lines into plain text (lines by "\n", pages by "\n\n") and note where
// each low-confidence word sits in that text, plus its box on the page (0-1 fractions).
// PDFs with a text layer come back with Words only (Lines is empty), so rebuild reading-order
// lines: group words whose vertical centres are close, then order each group left to right.
function linesFromWords(words) {
  const placed = (words || [])
    .filter(word => typeof word.text === "string" && word.text && word.box && ["x", "y", "w", "h"].every(k => Number.isFinite(word.box[k])))
    .map(word => ({ word, cy: word.box.y + word.box.h / 2, h: word.box.h }))
    .sort((a, b) => a.cy - b.cy || a.word.box.x - b.word.box.x);
  const groups = [];
  for (const item of placed) {
    const line = groups[groups.length - 1];
    if (line && Math.abs(item.cy - line.cy) <= Math.max(item.h, line.h) * 0.5) {
      line.items.push(item);
      line.cy = line.items.reduce((sum, i) => sum + i.cy, 0) / line.items.length;
      line.h = Math.max(line.h, item.h);
    } else {
      groups.push({ cy: item.cy, h: item.h, items: [item] });
    }
  }
  return groups.map(group => {
    const lineWords = group.items.sort((a, b) => a.word.box.x - b.word.box.x).map(i => i.word);
    return { text: lineWords.map(word => word.text).join(" "), words: lineWords };
  });
}

function buildText(items) {
  let text = "";
  const uncertain = [];
  for (const page of items) {
    const given = (page.Lines || []).filter(line => typeof line.text === "string" && line.text);
    const lines = given.length ? given : linesFromWords(page.Words);
    if (!lines.length) continue;
    if (text) text += "\n\n";
    lines.forEach((line, lineIndex) => {
      if (lineIndex) text += "\n";
      const lineStart = text.length;
      text += line.text;
      let cursor = 0;
      for (const word of line.words || []) {
        if (typeof word.text !== "string" || !word.text) continue;
        const at = line.text.indexOf(word.text, cursor);
        if (at === -1) continue;
        cursor = at + word.text.length;
        const confidence = word.confidence;
        if (!confidence?.measured || typeof confidence.value !== "number" || confidence.value >= UNSURE_BELOW) continue;
        if (uncertain.length >= MAX_UNSURE) continue;
        const box = word.box && ["x", "y", "w", "h"].every(k => Number.isFinite(word.box[k])) ? word.box : null;
        uncertain.push({
          text: word.text,
          confidence: Math.round(confidence.value * 100) / 100,
          page: page.PageNumber,
          start: lineStart + at,
          end: lineStart + at + word.text.length,
          box: box && { x: box.x, y: box.y, w: box.w, h: box.h }
        });
      }
    });
  }
  return { text, uncertain };
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

// Words that point at the parts of a document people usually ask about.
const KEY_TERMS = ["total", "amount", "due", "date", "deadline", "pay", "balance", "account", "name", "period", "fee", "php", "₱"];
const STOP_WORDS = new Set("the and for what when where which who how this that with from are was were you your yours mine have has had can could should would will about into does did not but any all its it's ang ng sa mga ko mo ba na at kung ano kailan saan".split(" "));
const HEAD_LINES = 3; // the top of a document usually names the issuer and the document type

// Pick the parts of the document that fit in `room` characters: the first lines, then the lines
// that best match the question and the key terms, kept in their original order.
function selectExcerpt(text, question, room) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    // Split very long lines (OCR of a paragraph) so they can be chosen piece by piece.
    .flatMap(line => line.length > 300 ? line.match(/.{1,300}(?:\s|$)/g).map(part => part.trim()) : [line]);
  const whole = lines.join("\n");
  if (whole.length <= room) return whole;

  const terms = new Set([
    ...KEY_TERMS,
    ...String(question).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3 && !STOP_WORDS.has(word))
  ]);
  const score = line => {
    const lower = line.toLowerCase();
    let points = 0;
    for (const term of terms) if (lower.includes(term)) points += 2;
    if (/\d/.test(line)) points += 0.5;
    return points;
  };

  const gap = "\n...\n";
  const marker = "[excerpt]\n";
  const chosen = new Set();
  let used = marker.length;
  const take = index => {
    const cost = lines[index].length + gap.length; // worst case: a gap before every line
    if (used + cost > room) return false;
    chosen.add(index);
    used += cost;
    return true;
  };
  for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i++) take(i);
  lines
    .map((line, index) => ({ index, points: score(line) }))
    .filter(({ index }) => !chosen.has(index))
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .forEach(({ index }) => take(index)); // lines that don't fit are skipped; shorter ones may still fit

  let out = marker;
  let previous = -1;
  [...chosen].sort((a, b) => a - b).forEach(index => {
    if (previous !== -1) out += index === previous + 1 ? "\n" : gap;
    out += lines[index];
    previous = index;
  });
  return out;
}

// The brief, then (optionally) an excerpt of the document being discussed, then the question.
function buildChatMessage(question, doc, budget = CHAT_MAX_CHARS) {
  if (!doc) return CHAT_BRIEF + question;
  const head = `${BRIEF_CORE} The user asks about their document "${doc.title.slice(0, 60)}". OCR text (may have errors):\n<<<\n`;
  const tail = "\n>>>\nAnswer from this text; if it is not there, say so.\n\nUser message: " + question;
  const room = budget - head.length - tail.length;
  if (room < 200) {
    throw new LumenFailure(400, "AI_CHAT_QUERY_TOO_LONG", "That question is too long to send with the document. Please shorten it.");
  }
  return head + selectExcerpt(doc.text, question, room) + tail;
}

// Send a question; with a document, retry with a smaller excerpt if Lumen says it is too long.
async function sendFitted(instanceId, sessionId, question, doc) {
  const budgets = doc ? DOC_RETRY_BUDGETS : [CHAT_MAX_CHARS];
  for (let i = 0; ; i++) {
    try {
      return await sendMessage(instanceId, sessionId, buildChatMessage(question, doc, budgets[i]));
    } catch (error) {
      if (error.code !== "AI_CHAT_QUERY_TOO_LONG" || i === budgets.length - 1) throw error;
    }
  }
}

async function chat(sessionId, question, doc) {
  const instanceId = await getInstanceId();
  // The instance judges each message on its own, so every message carries the brief
  // (and the document excerpt, when the user is asking about one).
  const reply = (id, answer) => ({ sessionId: id, answer, outOfScope: isOutOfScope(answer) });
  if (sessionId) {
    try {
      return reply(sessionId, await sendFitted(instanceId, sessionId, question, doc));
    } catch (error) {
      if (!RESTART_CODES.has(error.code)) throw error;
    }
  }
  const newId = await createSession(instanceId);
  return reply(newId, await sendFitted(instanceId, newId, question, doc));
}

// ---------- Analyze: summary and key details of an OCR'd document ----------

const CATEGORIES = ["Bills", "Receipts", "Personal", "School", "Government", "Other"];
// Sent as a user question about the document (the same shape as document chat), because the
// instance's scope filter refused a bare "extract JSON" prompt in testing but accepts this.
// Kept short so more of the document fits in the ~2000-character message limit.
const ANALYZE_QUESTION =
  "Give me the key details of this document. Reply with only a JSON object with keys " +
  `"category" (${CATEGORIES.join(", ")}), "title" (short), "issuer", "amount" (as written), ` +
  '"dueDate" (YYYY-MM-DD), "summary" (1-2 simple sentences: what it is, what I may need to do). ' +
  "Use null if not in the text. Never guess.";

// Pull the first JSON object out of the reply and keep only well-formed fields.
function parseDetails(answer) {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(answer.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const str = (value, max) => {
    if (typeof value === "number" && Number.isFinite(value)) value = String(value);
    if (typeof value !== "string") return null;
    const clean = value.replace(/\s+/g, " ").trim();
    return clean && !/^(null|n\/a|none|unknown)$/i.test(clean) ? clean.slice(0, max) : null;
  };
  let dueDate = str(raw.dueDate, 10);
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate + "T00:00:00Z")))) dueDate = null;
  const details = {
    category: CATEGORIES.find(c => c.toLowerCase() === String(raw.category || "").trim().toLowerCase()) || null,
    title: str(raw.title, 80),
    issuer: str(raw.issuer, 100),
    amount: str(raw.amount, 40),
    dueDate,
    summary: str(raw.summary, 400)
  };
  return details.summary || details.title ? details : null;
}

async function analyzeDocument(text) {
  const instanceId = await getInstanceId();
  const doc = { title: "Uploaded document", text };
  // A fresh session per document, so earlier documents cannot leak into this one.
  const sessionId = await createSession(instanceId);
  let answer = await sendFitted(instanceId, sessionId, ANALYZE_QUESTION, doc);
  // The scope filter is not consistent, and this runs automatically, so retry once (5 credits).
  if (isOutOfScope(answer)) answer = await sendFitted(instanceId, sessionId, ANALYZE_QUESTION, doc);
  if (isOutOfScope(answer)) return { details: null, reason: "out-of-scope" };
  const details = parseDetails(answer);
  return details ? { details } : { details: null, reason: "unreadable" };
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
    const max = Math.floor((CHAT_MAX_CHARS - CHAT_BRIEF.length) / 100) * 100;
    throw new LumenFailure(400, "AI_CHAT_QUERY_TOO_LONG", `That question is too long for Lumen's assistant. Please keep it under about ${max} characters.`);
  }
  sendJson(res, 200, await chat(sessionId, message, readDocumentField(payload?.document)));
}

// Optional { title, text } of a saved document sent along with a request.
function readDocumentField(doc) {
  if (doc == null) return null;
  const text = typeof doc.text === "string" ? doc.text.trim() : "";
  if (!text) throw new LumenFailure(400, "EMPTY_DOCUMENT", "This document has no text to talk about.");
  if (text.length > MAX_DOC_CHARS) throw new LumenFailure(413, "DOCUMENT_TOO_LONG", "This document's text is too long.");
  const title = typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : "Untitled document";
  return { title, text };
}

async function handleAnalyze(req, res) {
  lumenConfig("chat");
  let payload;
  try {
    payload = JSON.parse((await readBody(req, CHAT_MAX_BODY)).toString("utf8"));
  } catch (error) {
    if (error instanceof LumenFailure) throw error;
    throw new LumenFailure(400, "BAD_JSON", "The request was not valid.");
  }
  const doc = readDocumentField({ title: "document", text: payload?.text });
  sendJson(res, 200, await analyzeDocument(doc.text));
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
  // MyRoom.html is the main page; its book opens the LINAW journal (Phantom.html).
  const relative = requested === "/" ? "MyRoom.html" : requested;
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
  "POST /api/analyze": handleAnalyze,
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
