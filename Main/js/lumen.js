// The browser side of Lumen. It only calls this app's own server (/api/ocr, /api/chat);
// server.js adds the credentials from .env. No key or secret exists in frontend code.
const lumen = {
  // Send the original file to Lumen OCR. Resolves to { text, status, pageCount, failedPages }.
  async ocr(file, mediaType) {
    return this.request("/api/ocr", {
      headers: { "Content-Type": mediaType, "X-Document-Name": encodeURIComponent(file.name) },
      body: file,
      timeoutMs: 150000 // upload + Lumen reading time
    });
  },

  // Send one question. The server keeps the conversation in a Lumen session.
  async chat(message) {
    const result = await this.request("/api/chat", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId: sessionStorage.getItem("linawChatSession") }),
      timeoutMs: 60000
    });
    sessionStorage.setItem("linawChatSession", result.sessionId);
    return { answer: result.answer, outOfScope: Boolean(result.outOfScope) };
  },

  async request(url, { headers, body, timeoutMs }) {
    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new LumenError(
        "network",
        error.name === "TimeoutError" ? "Lumen took too long to answer. Please try again." : SERVER_HINT
      );
    }
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    // A 404/405 without LINAW's error envelope means the page is served by something other
    // than server.js (Live Server, a double-clicked file, ...), so /api/* does not exist.
    if (!data?.error && (response.status === 404 || response.status === 405 || response.status === 501)) {
      throw new LumenError("no-server", SERVER_HINT);
    }
    if (!response.ok) {
      const code = data?.error?.code === "NOT_CONFIGURED" ? "not-configured" : data?.error?.code || "server";
      throw new LumenError(code, data?.error?.message || `The request failed (${response.status}).`);
    }
    if (!data) throw new LumenError("server", "The server sent back an unexpected reply.");
    return data;
  }
};

const SERVER_HINT = "Can't reach the LINAW server. Start it with \"npm start\" and open http://localhost:3000";

class LumenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// PDF.js is used only to draw a preview of a PDF's first page in the browser.
const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
let pdfjsPromise = null;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${PDFJS_BASE}pdf.min.js`;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => {
        pdfjsPromise = null;
        reject(new Error("Could not load the PDF reader."));
      };
      document.head.append(script);
    });
  }
  return pdfjsPromise;
}

// Render the first page of a PDF to a PNG Blob for the preview panel.
async function pdfFirstPageImage(file, scale = 1.2) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}
