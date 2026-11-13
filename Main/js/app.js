// Bookmark order controls the Previous/Next buttons and page indicator.
const pages = [
  { name: "home", accent: "coral" },
  { name: "collection", accent: "gold" },
  { name: "upload", accent: "green" },
  { name: "assistant", accent: "teal" },
  { name: "notes", accent: "plum" }
];

// Page-turn tuning. More segments = smoother bend, longer duration = slower turn,
// larger bend = more curl in the paper while it travels.
const LEAF_SEGMENTS = 14;
const PAGE_TURN_MS = 1000;
const MAX_BEND_DEG = 3.4;

// Shared prototype data and the page the book currently displays.
let currentPage = -1;
let activeFilter = "All";
let collectionQuery = "";
// The chat starts blank and is kept for this visit only.
const conversation = [];
let viewerUrl = null;

// The left page never changes, so it is also used as the back of every turning leaf.
const leftNoteMarkup = `
  <div class="left-leaf-note">
    <div class="leaf-emblem">L</div>
    <p class="leaf-kicker">A PERSONAL DOCUMENT JOURNAL</p>
    <h2>Keep what<br><em>matters.</em></h2>
    <p class="leaf-copy">A calmer place for everyday papers, useful details, and little things worth remembering.</p>
    <div class="leaf-footer">LINAW · EST. 2026</div>
  </div>`;

// Elements that remain in Phantom.html while page content changes.
const bookArt = document.getElementById("bookArt");
const leftPage = document.getElementById("leftPage");
const rightPage = document.getElementById("rightPage");
const pageIndicator = document.getElementById("pageIndicator");
const prevButton = document.getElementById("prevButton");
const nextButton = document.getElementById("nextButton");
const pageLeafStage = document.getElementById("pageLeafStage");
const bookmarks = [...document.querySelectorAll(".bookmark")];
const pageMarkupCache = new Map();
let turnInProgress = false;

// Fetch a page's HTML fragment once and reuse it, so revisiting a bookmark is instant.
function loadPageMarkup(name) {
  if (!pageMarkupCache.has(name)) {
    const request = fetch(`pages/${name}.html`).then(response => {
      if (!response.ok) throw new Error(`Could not load pages/${name}.html`);
      return response.text();
    });
    pageMarkupCache.set(name, request);
  }
  return pageMarkupCache.get(name);
}

// Show the chosen page, playing one page turn for every step between the old and new page.
async function renderPage(index, animate = true) {
  const targetIndex = Math.max(0, Math.min(index, pages.length - 1));
  if (turnInProgress || targetIndex === currentPage) return;
  const page = pages[targetIndex];

  turnInProgress = true;
  setNavigationBusy(true);

  try {
    if (animate && currentPage !== -1 && canAnimate()) {
      const direction = targetIndex > currentPage ? 1 : -1;
      while (currentPage !== targetIndex) {
        const nextIndex = currentPage + direction;
        const nextMarkup = await getPageMarkup(nextIndex);
        const currentMarkup = rightPage.innerHTML;

        if (direction > 0) {
          // Forward: the next page is revealed underneath while the current page lifts away.
          rightPage.innerHTML = nextMarkup;
          await animatePageLeaf(currentMarkup, leftNoteMarkup, direction);
        } else {
          // Backward: the previous page swings in from the left and lands on top.
          await animatePageLeaf(nextMarkup, leftNoteMarkup, direction);
          rightPage.innerHTML = nextMarkup;
        }
        currentPage = nextIndex;
        bookArt.dataset.accent = pages[currentPage].accent;
      }
    } else {
      rightPage.innerHTML = await getPageMarkup(targetIndex);
      currentPage = targetIndex;
    }
    leftPage.innerHTML = leftNoteMarkup;

    bookArt.dataset.accent = page.accent;
    updateBookNavigation(page);
  } finally {
    turnInProgress = false;
    setNavigationBusy(false);
  }

  // Attach controls after their HTML fragment has entered the document.
  if (rightPage.querySelector(".page-load-error")) return;
  closeViewerUrl();
  bindPageInteractions(page.name);
  if (page.name === "collection") renderDocuments();
  if (page.name === "assistant") renderConversation();
  if (page.name === "home") updateHomeCounts();
}

// Free the temporary address used to show an original file in the viewer.
function closeViewerUrl() {
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
}

// Show how many documents and notes are really saved.
async function updateHomeCounts() {
  const docCount = document.getElementById("homeDocCount");
  const noteCount = document.getElementById("homeNoteCount");
  if (!docCount || !noteCount) return;
  try {
    const entries = await store.all();
    const notes = entries.filter(entry => entry.type === "note").length;
    docCount.textContent = entries.length - notes;
    noteCount.textContent = notes;
  } catch (error) {
    console.error(error);
  }
}

// Get a page's markup, or a friendly error message if it could not be fetched.
async function getPageMarkup(index) {
  const page = pages[index];
  try {
    return await loadPageMarkup(page.name);
  } catch (error) {
    pageMarkupCache.delete(page.name);
    console.error(error);
    return '<p class="page-lead page-load-error" role="alert">This page could not load. Start the LINAW server with "npm start" and open http://localhost:3000</p>';
  }
}

// Disable every navigation control while a page is turning (or at the first/last page).
function setNavigationBusy(busy) {
  bookArt.setAttribute("aria-busy", String(busy));
  prevButton.disabled = busy || currentPage <= 0;
  nextButton.disabled = busy || currentPage >= pages.length - 1;
  bookmarks.forEach(button => { button.disabled = busy; });
}

// Page turns are skipped for people who prefer reduced motion and on the stacked phone layout.
function canAnimate() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    !window.matchMedia("(max-width: 700px)").matches;
}

// Create one slice of a leaf face; "offset" slides the full-size page so the slices line up.
function buildLeafFace(className, markup, offset) {
  const face = document.createElement("div");
  face.className = `leaf-face ${className}`;
  const content = document.createElement("div");
  content.className = "leaf-content";
  content.style.left = `${offset}px`;
  content.innerHTML = markup;
  face.append(content);
  return face;
}

// Build a leaf as a chain of thin segments; each hangs off the previous one so it can bend.
function buildLeaf(frontMarkup, backMarkup, leafWidth) {
  const leaf = document.createElement("div");
  leaf.className = "turning-leaf";
  leaf.setAttribute("aria-hidden", "true");
  leaf.inert = true;
  const segmentWidth = leafWidth / LEAF_SEGMENTS;
  leaf.style.setProperty("--leaf-w", `${leafWidth}px`);
  leaf.style.setProperty("--seg-w", `${segmentWidth}px`);

  const segments = [];
  let parent = leaf;
  for (let i = 0; i < LEAF_SEGMENTS; i++) {
    const segment = document.createElement("div");
    segment.className = "leaf-segment";
    // The back face is mirrored, so its slices run in the opposite order to the front.
    segment.append(
      buildLeafFace("leaf-face-front", frontMarkup, -i * segmentWidth),
      buildLeafFace("leaf-face-back", backMarkup, -(LEAF_SEGMENTS - 1 - i) * segmentWidth)
    );
    parent.append(segment);
    segments.push(segment);
    parent = segment;
  }
  return { leaf, segments };
}

// Place the leaf for one animation frame: the first segment hinges at the spine,
// and every other segment adds a little extra bend so the page curls like paper.
function poseLeaf({ segments, shadowRight, shadowLeft }, time, direction) {
  // Gentle ease in and out so the page accelerates off the stack and settles softly.
  const eased = 0.5 - Math.cos(Math.PI * time) / 2;
  const turn = direction > 0 ? -180 * eased : -180 * (1 - eased);
  // The free edge lags behind while lifting, then leads as the page falls into place.
  const bend = direction * MAX_BEND_DEG * Math.sin(2 * Math.PI * eased);

  segments.forEach((segment, i) => {
    segment.style.transform = `rotateY(${i === 0 ? turn : bend}deg)`;
    // Segments tilted away from the viewer pick up a soft shadow.
    const angle = ((turn + i * bend) * Math.PI) / 180;
    segment.style.setProperty("--shade", (0.34 * (1 - Math.abs(Math.cos(angle)))).toFixed(3));
  });

  // The lifted leaf shades whichever page it is hovering over.
  const turnRadians = (Math.abs(turn) * Math.PI) / 180;
  const shadowStrength = (0.6 * Math.abs(Math.sin(2 * turnRadians))).toFixed(3);
  shadowRight.style.opacity = Math.cos(turnRadians) > 0 ? shadowStrength : 0;
  shadowLeft.style.opacity = Math.cos(turnRadians) > 0 ? 0 : shadowStrength;
}

// Play a single page turn. Resolves when the leaf has landed and been removed.
function animatePageLeaf(frontMarkup, backMarkup, direction) {
  if (!canAnimate()) return Promise.resolve();

  return new Promise(resolve => {
    const { leaf, segments } = buildLeaf(frontMarkup, backMarkup, pageLeafStage.clientWidth);
    const shadowRight = document.createElement("div");
    const shadowLeft = document.createElement("div");
    shadowRight.className = "turn-shadow";
    shadowLeft.className = "turn-shadow turn-shadow-left";
    const pose = { segments, shadowRight, shadowLeft };
    poseLeaf(pose, 0, direction);
    pageLeafStage.append(shadowRight, shadowLeft, leaf);

    const startTime = performance.now();
    // Runs once per screen refresh until the turn is finished.
    function frame(now) {
      const time = Math.min(1, (now - startTime) / PAGE_TURN_MS);
      poseLeaf(pose, time, direction);
      if (time < 1) {
        window.requestAnimationFrame(frame);
        return;
      }
      leaf.remove();
      shadowRight.remove();
      shadowLeft.remove();
      resolve();
    }
    window.requestAnimationFrame(frame);
  });
}

// Keep the indicator, step buttons, document count, and bookmark in sync.
function updateBookNavigation(page) {
  pageIndicator.textContent = `${String(currentPage + 1).padStart(2, "0")} / ${String(pages.length).padStart(2, "0")}`;
  prevButton.disabled = currentPage === 0;
  nextButton.disabled = currentPage === pages.length - 1;

  bookmarks.forEach(button => {
    const selected = button.dataset.page === page.name;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

// Attach only the interactions used by the page that was just loaded.
function bindPageInteractions(name) {
  document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => goTo(button.dataset.go));
  });
  if (name === "upload") bindUpload();
  if (name === "collection") bindCollection();
  if (name === "assistant") bindAssistant();
  if (name === "notes") bindNotes();
}

// ---------- New Entry: choose, preview, read with Lumen OCR, review, save ----------
function bindUpload() {
  const byId = id => document.getElementById(id);
  const input = byId("fileInput");
  const zone = byId("dropZone");
  const feedback = byId("fileFeedback");
  const steps = { choose: byId("stepChoose"), preview: byId("stepPreview"), review: byId("stepReview") };
  const previewPanel = byId("previewPanel");
  const readButton = byId("readDocument");
  const saveButton = byId("saveDocument");
  let selected = null; // { file, mime }
  let previewUrl = null;

  function showStep(step) {
    Object.entries(steps).forEach(([key, element]) => { element.hidden = key !== step; });
  }

  function reset(message = "No document selected yet.") {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    selected = null;
    input.value = "";
    previewPanel.replaceChildren();
    byId("ocrOutput").value = "";
    byId("entryTitle").value = "";
    readButton.disabled = false;
    saveButton.disabled = false;
    feedback.textContent = message;
    showStep("choose");
  }

  async function chooseFile(file) {
    if (!file) return;
    const result = await validateFile(file);
    if (!result.ok) {
      feedback.textContent = result.message;
      input.value = "";
      return;
    }
    selected = { file, mime: result.mime };
    feedback.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB ready.`;
    byId("entryTitle").value = file.name.replace(/\.[^.]+$/, "").slice(0, 100);
    await showPreview();
    showStep("preview");
  }

  // Show the original: the image itself, or the first page of a PDF.
  async function showPreview() {
    previewPanel.replaceChildren();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    let blob = selected.file;
    if (selected.mime === "application/pdf") {
      try {
        blob = await pdfFirstPageImage(selected.file);
      } catch (error) {
        console.error(error);
        previewPanel.textContent = "PDF ready. A preview could not be drawn.";
        previewUrl = null;
        return;
      }
    }
    previewUrl = URL.createObjectURL(blob);
    const image = document.createElement("img");
    image.src = previewUrl;
    image.alt = `Preview of ${selected.file.name}`;
    previewPanel.append(image);
  }

  input.addEventListener("change", () => chooseFile(input.files[0]));
  zone.addEventListener("dragover", event => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", event => {
    if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
    zone.classList.remove("dragover");
  });
  zone.addEventListener("drop", event => {
    event.preventDefault();
    zone.classList.remove("dragover");
    chooseFile(event.dataTransfer.files[0]);
  });
  byId("cancelUpload").addEventListener("click", () => reset());
  byId("discardDocument").addEventListener("click", () => reset("Discarded. Nothing was saved."));

  readButton.addEventListener("click", async () => {
    if (!selected) return;
    const cancelButton = byId("cancelUpload");
    const setBusy = busy => {
      readButton.disabled = busy;
      cancelButton.disabled = busy;
      readButton.classList.toggle("is-loading", busy);
      readButton.textContent = busy ? "Reading..." : "Read with Lumen OCR";
      steps.preview.setAttribute("aria-busy", String(busy));
    };
    setBusy(true);
    feedback.textContent = "Lumen OCR is reading your document. This can take a few seconds...";
    let text = "";
    let note = "Review the text below. You can edit it before saving.";
    try {
      const result = await lumen.ocr(selected.file, selected.mime);
      text = result.text;
      if (!text) note = "Lumen found no readable text. You can type it in yourself.";
      else if (result.status === "PARTIAL") {
        note = `Some pages could not be read (${result.failedPages.join(", ") || "unknown"}). Review and fill in anything missing.`;
      }
    } catch (error) {
      if (!input.isConnected) return;
      setBusy(false);
      if (!(error instanceof LumenError) || error.code !== "not-configured") {
        console.error(error);
        feedback.textContent = error.message || "Could not read the document. Please try again.";
        return;
      }
      note = "Lumen OCR is not connected yet. You can type the text yourself.";
    }
    if (!input.isConnected) return; // the user turned the page meanwhile
    setBusy(false);
    byId("ocrOutput").value = text;
    feedback.textContent = note;
    showStep("review");
  });

  saveButton.addEventListener("click", async () => {
    if (!selected) return;
    const title = byId("entryTitle").value.trim();
    if (!title) {
      feedback.textContent = "Please give this entry a title.";
      byId("entryTitle").focus();
      return;
    }
    saveButton.disabled = true;
    try {
      await store.add({
        type: "document",
        title,
        category: byId("categorySelect").value,
        mime: selected.mime,
        size: selected.file.size,
        fileBlob: selected.file,
        ocrText: byId("ocrOutput").value
      });
    } catch (error) {
      console.error(error);
      feedback.textContent = "Could not save this entry in your browser. Please try again.";
      saveButton.disabled = false;
      return;
    }
    reset();
    goTo("collection");
  });
}

// ---------- Collection: search, filter, open, delete ----------
function bindCollection() {
  const searchInput = document.getElementById("searchInput");
  searchInput.value = collectionQuery;
  searchInput.addEventListener("input", () => {
    collectionQuery = searchInput.value;
    renderDocuments();
  });
  document.querySelectorAll(".filter-chip").forEach(chip => chip.addEventListener("click", () => {
    activeFilter = chip.dataset.filter;
    updateFilterControls();
    renderDocuments();
  }));
  updateFilterControls();
}

// Highlight the active category chip in the Collection page.
function updateFilterControls() {
  document.querySelectorAll(".filter-chip").forEach(chip => {
    const selected = chip.dataset.filter === activeFilter;
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
}

let renderToken = 0;

// Draw the saved entries that match the search and filter, using text nodes only.
async function renderDocuments() {
  const list = document.getElementById("documentList");
  if (!list) return;
  const token = ++renderToken;
  let entries;
  try {
    entries = await store.all();
  } catch (error) {
    console.error(error);
    list.textContent = "Your saved entries could not be loaded.";
    return;
  }
  if (token !== renderToken || !list.isConnected) return;

  const query = collectionQuery.trim().toLowerCase();
  const matches = entries.filter(entry =>
    (activeFilter === "All" ||
      (activeFilter === "Notes" ? entry.type === "note" : entry.type === "document" && entry.category === activeFilter)) &&
    `${entry.title} ${entry.ocrText}`.toLowerCase().includes(query)
  );

  list.replaceChildren();
  if (!matches.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = entries.length
      ? "No entries match your search and category."
      : "Nothing saved yet. Add a document or write a note and it will appear here.";
    list.append(emptyState);
    return;
  }

  matches.forEach(entry => {
    const row = document.createElement("div");
    row.className = "doc-row";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "doc-open";
    open.setAttribute("aria-label", `Open ${entry.title}`);
    const icon = document.createElement("div");
    icon.className = "doc-icon";
    icon.textContent = entry.type === "note" ? "✎" : entry.mime === "application/pdf" ? "▤" : "▧";
    const meta = document.createElement("div");
    meta.className = "doc-meta";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const detail = document.createElement("small");
    const label = entry.type === "note" ? "Note" : entry.category;
    detail.textContent = `${label} · ${new Date(entry.createdAt).toLocaleDateString()}`;
    meta.append(title, detail);
    open.append(icon, meta);
    open.addEventListener("click", () => openViewer(entry));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "doc-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${entry.title}`);
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${entry.title}"? This cannot be undone.`)) return;
      await store.remove(entry.id);
      renderDocuments();
    });

    row.append(open, remove);
    list.append(row);
  });
}

// Show the original on the left page and the AI-read text on the right page.
function openViewer(entry) {
  closeViewerUrl();
  const left = document.createElement("div");
  left.className = "viewer-pane";
  const leftLabel = document.createElement("div");
  leftLabel.className = "eyebrow";
  leftLabel.textContent = entry.type === "note" ? "YOUR NOTE" : "ORIGINAL FILE";
  left.append(leftLabel);

  if (entry.type === "note") {
    const heading = document.createElement("h2");
    heading.textContent = entry.title;
    const when = document.createElement("p");
    when.className = "tiny-note";
    when.textContent = `Written ${new Date(entry.createdAt).toLocaleString()}`;
    left.append(heading, when);
  } else {
    viewerUrl = URL.createObjectURL(entry.fileBlob);
    if (entry.mime === "application/pdf") {
      const frame = document.createElement("iframe");
      frame.className = "viewer-original";
      frame.src = viewerUrl;
      frame.title = `Original: ${entry.title}`;
      left.append(frame);
    } else {
      const image = document.createElement("img");
      image.className = "viewer-original";
      image.src = viewerUrl;
      image.alt = `Original: ${entry.title}`;
      left.append(image);
    }
  }

  const right = document.createElement("div");
  right.className = "viewer-pane";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "paper-button";
  back.textContent = "← Back to collection";
  back.addEventListener("click", closeViewer);
  const rightLabel = document.createElement("div");
  rightLabel.className = "eyebrow";
  rightLabel.textContent = entry.type === "note" ? "NOTE TEXT" : "READ BY LUMEN OCR";
  const heading = document.createElement("h2");
  heading.textContent = entry.title;
  const text = document.createElement("pre");
  text.className = "viewer-text";
  text.textContent = entry.ocrText || "No text was saved for this entry.";
  right.append(back, rightLabel, heading, text);

  leftPage.replaceChildren(left);
  rightPage.replaceChildren(right);
  right.scrollIntoView({ block: "start" });
  back.focus();
}

// Put the collection list back where the viewer was.
async function closeViewer() {
  closeViewerUrl();
  rightPage.innerHTML = await getPageMarkup(currentPage);
  leftPage.innerHTML = leftNoteMarkup;
  rightPage.scrollTop = 0;
  bindPageInteractions("collection");
  renderDocuments();
}

// ---------- Ask LINAW ----------
function bindAssistant() {
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const counter = document.getElementById("chatCounter");
  const status = document.getElementById("chatStatus");
  const send = document.getElementById("chatSend");

  input.addEventListener("input", () => {
    if (countWords(input.value) > MAX_CHAT_WORDS) input.value = limitWords(input.value, MAX_CHAT_WORDS);
    counter.textContent = `${countWords(input.value)} / ${MAX_CHAT_WORDS} words`;
    status.textContent = "";
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || send.disabled) return;
    if (countWords(message) > MAX_CHAT_WORDS) {
      status.textContent = `Please keep your question to ${MAX_CHAT_WORDS} words.`;
      return;
    }

    conversation.push({ role: "user", message });
    input.value = "";
    counter.textContent = `0 / ${MAX_CHAT_WORDS} words`;
    status.textContent = "LINAW is thinking...";
    send.disabled = true;
    input.disabled = true;
    renderConversation(true);

    try {
      const reply = await lumen.chat(message);
      conversation.push({ role: "bot", message: reply.answer });
      status.textContent = reply.outOfScope
        ? "Lumen's assistant skipped that one. Try asking it a different way, e.g. \"What does amount due mean on my bill?\""
        : "";
    } catch (error) {
      // Take the unanswered question back out and return it to the box so it can be resent.
      conversation.pop();
      if (input.isConnected && !input.value) {
        input.value = message;
        counter.textContent = `${countWords(message)} / ${MAX_CHAT_WORDS} words`;
      }
      status.textContent = error.message || "Something went wrong. Please try again.";
    }
    send.disabled = false;
    input.disabled = false;
    renderConversation();
    if (input.isConnected) input.focus();
  });
}

// Draw the chat bubbles and scroll to the newest message.
function renderConversation(waiting = false) {
  const chat = document.getElementById("chatMessages");
  if (!chat) return;
  chat.replaceChildren();
  conversation.forEach(({ role, message }) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;
    bubble.textContent = message;
    chat.append(bubble);
  });
  if (waiting) {
    const typing = document.createElement("div");
    typing.className = "chat-bubble bot typing";
    typing.setAttribute("aria-label", "LINAW is typing");
    typing.append(...[0, 1, 2].map(() => document.createElement("span")));
    chat.append(typing);
  }
  chat.scrollTop = chat.scrollHeight;
}

// ---------- Notes ----------
function bindNotes() {
  const titleInput = document.getElementById("noteTitle");
  const bodyInput = document.getElementById("noteBody");
  const counter = document.getElementById("noteCounter");
  const feedback = document.getElementById("noteFeedback");
  const save = document.getElementById("saveNote");

  bodyInput.addEventListener("input", () => {
    if (countWords(bodyInput.value) > MAX_NOTE_WORDS) bodyInput.value = limitWords(bodyInput.value, MAX_NOTE_WORDS);
    counter.textContent = `${countWords(bodyInput.value)} / ${MAX_NOTE_WORDS} words`;
  });

  save.addEventListener("click", async () => {
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!title || !body) {
      feedback.textContent = "Add a title and a note before saving.";
      (title ? bodyInput : titleInput).focus();
      return;
    }
    if (countWords(body) > MAX_NOTE_WORDS) {
      feedback.textContent = `Notes can be up to ${MAX_NOTE_WORDS} words.`;
      return;
    }
    save.disabled = true;
    try {
      await store.add({ type: "note", title, category: "Notes", ocrText: body });
    } catch (error) {
      console.error(error);
      feedback.textContent = "Could not save this note in your browser. Please try again.";
      save.disabled = false;
      return;
    }
    save.disabled = false;
    titleInput.value = "";
    bodyInput.value = "";
    counter.textContent = `0 / ${MAX_NOTE_WORDS} words`;
    feedback.textContent = "Note saved. You can find it in your collection under Notes.";
  });
}

// Resolve a section bookmark to its position in the book.
function goTo(pageName) {
  const pageIndex = pages.findIndex(page => page.name === pageName);
  if (pageIndex !== -1) renderPage(pageIndex);
}

// Connect the shared controls once; page-specific controls are bound after loading.
document.querySelector(".brand").addEventListener("click", event => {
  event.preventDefault();
  goTo("home");
});
bookmarks.forEach(button => button.addEventListener("click", () => goTo(button.dataset.page)));
prevButton.addEventListener("click", () => renderPage(currentPage - 1));
nextButton.addEventListener("click", () => renderPage(currentPage + 1));

// Left and right arrow keys turn the page, unless the user is typing or a dialog is open.
document.addEventListener("keydown", event => {
  if (aboutDialog.open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === "ArrowRight") {
    event.preventDefault();
    renderPage(currentPage + 1);
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    renderPage(currentPage - 1);
  }
});

// The About dialog is shared by every page in the book.
const aboutDialog = document.getElementById("aboutDialog");
document.getElementById("helpButton").addEventListener("click", () => aboutDialog.showModal());
document.getElementById("closeDialog").addEventListener("click", () => aboutDialog.close());

// Where each twinkling star sits: [left %, top %, size px, delay s, duration s].
// Positions stay in the wood margins so stars never cover the book or its text.
const starSpots = [
  [24, 13, 13, 0, 4.2], [48, 14, 12, 2.1, 5], [75, 13.5, 13, 2.9, 4.6],
  [6, 36, 12, 0.4, 4.4], [5, 58, 14, 1.1, 5.2], [10, 78, 12, 3.1, 4.1],
  [93, 26, 12, 1.9, 4.3], [95, 68, 14, 2.3, 5.1],
  [24, 93, 12, 0.6, 4.5], [76, 93, 13, 0.3, 5]
];

// Create the star elements. Each one twinkles on its own timing so they never pulse in sync.
function buildStarfield() {
  const field = document.getElementById("starfield");
  if (!field) return;
  starSpots.forEach(([x, y, size, delay, duration]) => {
    const star = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    star.setAttribute("class", "star");
    star.setAttribute("viewBox", "0 0 100 100");
    star.style.setProperty("--x", `${x}%`);
    star.style.setProperty("--y", `${y}%`);
    star.style.setProperty("--size", `${Math.round(size * 2)}px`);
    star.style.setProperty("--delay", `${-delay}s`);
    star.style.setProperty("--dur", `${duration}s`);
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "use");
    shape.setAttribute("href", "#star");
    shape.setAttribute("width", "100");
    shape.setAttribute("height", "100");
    star.append(shape);
    field.append(star);
  });
}

buildStarfield();

// Load the cover page without animating on the initial visit.
renderPage(0, false);
