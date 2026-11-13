// The only file that talks to Lumen. It reads window.LUMEN_CONFIG (js/config.js).
// If you change the request or response format of the Lumen API, edit the two
// "ADAPTER" functions below and nothing else.
const lumen = {
  // True once a real key and endpoint have been filled in.
  isConfigured(kind) {
    const config = window.LUMEN_CONFIG || {};
    const url = kind === "chat" ? config.chatUrl : config.ocrUrl;
    return Boolean(
      config.apiKey && config.apiKey !== "PASTE_YOUR_KEY_HERE" &&
      url && /^https:\/\/[^.]+\./.test(url)
    );
  },

  headers() {
    const config = window.LUMEN_CONFIG;
    return { [config.authHeader || "Authorization"]: `${config.authScheme ?? "Bearer "}${config.apiKey}` };
  },

  // Send one or more page images (Blobs) to Lumen OCR and return the text it read.
  async ocr(images) {
    if (!this.isConfigured("ocr")) throw new LumenError("not-configured", "Lumen OCR is not connected yet.");
    const parts = [];
    for (let i = 0; i < images.length; i++) {
      const response = await this.post(this.buildOcrRequest(images[i]), "ocrUrl");
      parts.push(this.parseOcrResponse(await response.json()));
    }
    return parts.join("\n\n").trim();
  },

  // Send the whole conversation ([{ role: "user" | "bot", message }]) and return Lumen's reply.
  async chat(history) {
    if (!this.isConfigured("chat")) throw new LumenError("not-configured", "Lumen chat is not connected yet.");
    const response = await this.post(this.buildChatRequest(history), "chatUrl");
    return this.parseChatResponse(await response.json());
  },

  // ADAPTER: how an OCR request is built. Change the field name here if Lumen expects another.
  buildOcrRequest(image) {
    const form = new FormData();
    form.append("file", image, "page.png");
    return { body: form };
  },

  // ADAPTER: where the text sits in Lumen's OCR response.
  parseOcrResponse(data) {
    const text = data.text ?? data.result?.text ?? data.data?.text ?? data.ocr_text ?? data.content;
    return typeof text === "string" ? text : "";
  },

  // ADAPTER: how a chat request is built.
  buildChatRequest(history) {
    const messages = history.map(({ role, message }) => ({
      role: role === "bot" ? "assistant" : "user",
      content: message
    }));
    return {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    };
  },

  // ADAPTER: where the reply sits in Lumen's chat response.
  parseChatResponse(data) {
    const reply = data.choices?.[0]?.message?.content ?? data.reply ?? data.response ?? data.message ?? data.text;
    if (typeof reply !== "string" || !reply.trim()) throw new LumenError("empty", "Lumen sent back an empty reply.");
    return reply.trim();
  },

  async post({ headers = {}, body }, urlKey) {
    let response;
    try {
      response = await fetch(window.LUMEN_CONFIG[urlKey], {
        method: "POST",
        headers: { ...this.headers(), ...headers },
        body,
        signal: AbortSignal.timeout(60000)
      });
    } catch (error) {
      const timedOut = error.name === "TimeoutError";
      throw new LumenError("network", timedOut ? "Lumen took too long to answer." : "Could not reach Lumen. Check your connection.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new LumenError("auth", "Lumen rejected the API key. Check js/config.js.");
    }
    if (!response.ok) throw new LumenError("server", `Lumen returned an error (${response.status}).`);
    return response;
  }
};

class LumenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Turn a PDF (or image) File into a list of PNG Blobs, at most `maxPages` for PDFs.
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

async function pdfToImages(file, maxPages = 5, scale = 2) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const images = [];
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    images.push(await new Promise(resolve => canvas.toBlob(resolve, "image/png")));
  }
  return images;
}
