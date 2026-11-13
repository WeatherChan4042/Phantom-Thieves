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

    // Documents with a due date from Lumen AI, today through the next 7 days.
    const upcoming = entries
      .filter(entry => entry.type === "document" && entry.details?.dueDate)
      .map(entry => ({ entry, days: daysUntil(entry.details.dueDate) }))
      .filter(({ days }) => days >= 0 && days <= 7)
      .sort((a, b) => a.days - b.days);
    const dueCount = document.getElementById("homeDueCount");
    const nextDue = document.getElementById("homeNextDue");
    if (dueCount) dueCount.textContent = upcoming.length;
    if (nextDue) {
      nextDue.hidden = !upcoming.length;
      if (upcoming.length) {
        const { entry } = upcoming[0];
        nextDue.textContent = `Next: ${entry.title}, ${dueLabel(entry.details.dueDate)}` +
          (entry.details.amount ? ` · ${entry.details.amount}` : "");
      }
    }
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

// ---------- Shared helpers: small elements, due dates, key-details card ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Whole days from today until an ISO date (YYYY-MM-DD); negative when it has passed.
function daysUntil(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${iso}T00:00:00`) - today) / 86400000);
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function dueLabel(iso) {
  const days = daysUntil(iso);
  if (days < 0) return `overdue by ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days} days`;
}

// Fill a container with the summary and key details Lumen AI found.
function renderDetails(container, details) {
  container.replaceChildren(el("div", "eyebrow", "KEY DETAILS · LUMEN AI"));
  if (details.summary) container.append(el("p", "details-summary", details.summary));
  const rows = [
    ["From", details.issuer],
    ["Amount", details.amount],
    ["Due", details.dueDate && `${formatDate(details.dueDate)} (${dueLabel(details.dueDate)})`]
  ].filter(([, value]) => value);
  if (rows.length) {
    const list = el("dl", "details-list");
    rows.forEach(([label, value]) => list.append(el("dt", "", label), el("dd", "", value)));
    container.append(list);
  }
  container.append(el("p", "tiny-note", "Made by AI from the OCR text. Check it against the original."));
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
  const cancelButton = byId("cancelUpload");
  const saveButton = byId("saveDocument");
  const titleInput = byId("entryTitle");
  const categorySelect = byId("categorySelect");
  const textArea = byId("ocrOutput");
  const detailsCard = byId("detailsCard");
  const unsureBox = byId("unsureBox");
  let selected = null; // { file, mime }
  let previewUrl = null;
  let run = 0; // bumps on every new file or reset, so late replies for an old file are ignored
  let analysis = null; // { promise, details }
  let titleEdited = false;
  let categoryEdited = false;

  function showStep(step) {
    Object.entries(steps).forEach(([key, element]) => { element.hidden = key !== step; });
    previewPanel.hidden = step === "choose";
  }

  function reset(message = "No document selected yet.") {
    run++;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    selected = null;
    analysis = null;
    input.value = "";
    previewPanel.replaceChildren();
    textArea.value = "";
    titleInput.value = "";
    detailsCard.replaceChildren();
    detailsCard.hidden = true;
    unsureBox.hidden = true;
    readButton.disabled = false;
    cancelButton.disabled = false;
    saveButton.disabled = false;
    saveButton.textContent = "Keep and save";
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
    reset();
    selected = { file, mime: result.mime };
    titleEdited = false;
    categoryEdited = false;
    feedback.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB ready.`;
    titleInput.value = file.name.replace(/\.[^.]+$/, "").slice(0, 100);
    await showPreview();
    showStep("preview");
  }

  // Show the original (the image, or a PDF's first page) with a layer for word outlines.
  async function showPreview() {
    previewPanel.replaceChildren();
    let blob = selected.file;
    if (selected.mime === "application/pdf") {
      try {
        blob = await pdfFirstPageImage(selected.file);
      } catch (error) {
        console.error(error);
        previewPanel.textContent = "PDF ready. A preview could not be drawn.";
        return;
      }
    }
    previewUrl = URL.createObjectURL(blob);
    const frame = el("div", "preview-frame");
    const image = document.createElement("img");
    image.src = previewUrl;
    image.alt = `Preview of ${selected.file.name}`;
    frame.append(image, el("div", "preview-boxes"));
    previewPanel.append(frame);
  }

  // Feature: list the words Lumen was unsure about and outline them on the preview.
  function showUncertain(uncertain) {
    const chips = byId("unsureChips");
    const label = byId("unsureLabel");
    const boxes = previewPanel.querySelector(".preview-boxes");
    chips.replaceChildren();
    if (boxes) boxes.replaceChildren();
    unsureBox.hidden = false;
    if (!uncertain.length) {
      label.textContent = "Lumen was confident about every word.";
      return;
    }
    label.textContent = `Lumen was unsure about ${uncertain.length} word${uncertain.length === 1 ? "" : "s"}. Tap one to check it:`;
    uncertain.forEach((word, index) => {
      // Outline on the preview; the preview only shows page 1.
      let outline = null;
      if (boxes && word.page === 1 && word.box) {
        outline = el("span", "word-box");
        Object.assign(outline.style, {
          left: `${word.box.x * 100}%`, top: `${word.box.y * 100}%`,
          width: `${word.box.w * 100}%`, height: `${word.box.h * 100}%`
        });
        boxes.append(outline);
      }
      const chip = el("button", "unsure-chip", word.text);
      chip.type = "button";
      const sure = `${Math.round(word.confidence * 100)}% sure`;
      chip.title = `${sure} · page ${word.page}`;
      chip.setAttribute("aria-label", `${word.text}, ${sure}, page ${word.page}. Select it in the text.`);
      chip.addEventListener("click", () => {
        previewPanel.querySelectorAll(".word-box.active").forEach(box => box.classList.remove("active"));
        if (outline) {
          outline.classList.add("active");
          outline.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        // Use the saved position if the text there is unchanged, otherwise find the word.
        let start = textArea.value.slice(word.start, word.end) === word.text ? word.start : textArea.value.indexOf(word.text);
        if (start === -1) {
          feedback.textContent = `"${word.text}" is no longer in the text.`;
          return;
        }
        textArea.focus();
        textArea.setSelectionRange(start, start + word.text.length);
        chips.querySelectorAll(".unsure-chip").forEach((other, i) => other.classList.toggle("active", i === index));
      });
      chips.append(chip);
    });
  }

  // Feature: ask Lumen AI for a summary and key details; fill in the title and section.
  function startAnalysis(text, thisRun) {
    detailsCard.hidden = false;
    detailsCard.replaceChildren(el("div", "eyebrow", "KEY DETAILS · LUMEN AI"), el("p", "details-loading", "Lumen AI is summarizing this document..."));
    detailsCard.setAttribute("aria-busy", "true");
    const state = { details: null };
    state.promise = lumen.analyze(text).then(result => {
      if (thisRun !== run) return;
      state.details = result.details;
      if (!result.details) {
        detailsCard.replaceChildren(el("div", "eyebrow", "KEY DETAILS · LUMEN AI"),
          el("p", "tiny-note", "Lumen AI couldn't summarize this one. You can still review and save the text."));
        return;
      }
      renderDetails(detailsCard, result.details);
      const filled = [];
      if (!titleEdited && result.details.title) { titleInput.value = result.details.title.slice(0, 100); filled.push("title"); }
      if (!categoryEdited && result.details.category) { categorySelect.value = result.details.category; filled.push("section"); }
      if (filled.length) feedback.textContent = `Lumen filled in the ${filled.join(" and ")}. Change anything that looks wrong, then save.`;
    }).catch(error => {
      if (thisRun !== run) return;
      console.error(error);
      detailsCard.replaceChildren(el("div", "eyebrow", "KEY DETAILS · LUMEN AI"),
        el("p", "tiny-note", `No summary: ${error.message || "Lumen AI is unavailable."} You can still save the text.`));
    }).finally(() => {
      if (thisRun === run) detailsCard.removeAttribute("aria-busy");
    });
    return state;
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
  titleInput.addEventListener("input", () => { titleEdited = true; });
  categorySelect.addEventListener("change", () => { categoryEdited = true; });
  cancelButton.addEventListener("click", () => reset());
  byId("discardDocument").addEventListener("click", () => reset("Discarded. Nothing was saved."));

  readButton.addEventListener("click", async () => {
    if (!selected) return;
    const thisRun = run;
    const setBusy = busy => {
      readButton.disabled = busy;
      cancelButton.disabled = busy;
      readButton.classList.toggle("is-loading", busy);
      readButton.textContent = busy ? "Reading..." : "Read with Lumen OCR";
      steps.preview.setAttribute("aria-busy", String(busy));
    };
    setBusy(true);
    feedback.textContent = "Lumen OCR is reading your document. This can take a few seconds...";
    let result = { text: "", uncertain: [] };
    let note = "Review the text below. You can edit it before saving.";
    try {
      result = await lumen.ocr(selected.file, selected.mime);
      if (!result.text) note = "Lumen found no readable text. You can type it in yourself.";
      else if (result.status === "PARTIAL") {
        note = `Some pages could not be read (${result.failedPages.join(", ") || "unknown"}). Review and fill in anything missing.`;
      }
    } catch (error) {
      if (!input.isConnected || thisRun !== run) return;
      setBusy(false);
      if (!(error instanceof LumenError) || error.code !== "not-configured") {
        console.error(error);
        feedback.textContent = error.message || "Could not read the document. Please try again.";
        return;
      }
      note = "Lumen OCR is not connected yet. You can type the text yourself.";
    }
    if (!input.isConnected || thisRun !== run) return; // the user turned the page or picked another file
    setBusy(false);
    textArea.value = result.text;
    feedback.textContent = note;
    showStep("review");
    if (result.text) {
      showUncertain(result.uncertain || []);
      analysis = startAnalysis(result.text, thisRun);
    }
  });

  saveButton.addEventListener("click", async () => {
    if (!selected) return;
    const title = titleInput.value.trim();
    if (!title) {
      feedback.textContent = "Please give this entry a title.";
      titleInput.focus();
      return;
    }
    saveButton.disabled = true;
    // Keep the summary with the entry: wait for it if Lumen is still working.
    if (analysis && !analysis.details) {
      saveButton.textContent = "Finishing summary...";
      await analysis.promise;
    }
    try {
      await store.add({
        type: "document",
        title,
        category: categorySelect.value,
        mime: selected.mime,
        size: selected.file.size,
        fileBlob: selected.file,
        ocrText: textArea.value,
        details: analysis?.details || null
      });
    } catch (error) {
      console.error(error);
      feedback.textContent = "Could not save this entry in your browser. Please try again.";
      saveButton.disabled = false;
      saveButton.textContent = "Keep and save";
      return;
    }
    if (!input.isConnected) return;
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
    `${entry.title} ${entry.ocrText} ${entry.details?.summary || ""} ${entry.details?.issuer || ""}`.toLowerCase().includes(query)
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
    const due = entry.type === "document" && entry.details?.dueDate ? ` · ${dueLabel(entry.details.dueDate)}` : "";
    detail.textContent = `${label} · ${new Date(entry.createdAt).toLocaleDateString()}${due}`;
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
  right.append(back, rightLabel, heading);

  if (entry.details) {
    const card = el("section", "details-card");
    card.setAttribute("aria-label", "Key details from Lumen AI");
    renderDetails(card, entry.details);
    right.append(card);
  }

  const actions = el("div", "button-row");
  const actionFeedback = el("p", "tiny-note");
  actionFeedback.setAttribute("role", "status");
  actionFeedback.setAttribute("aria-live", "polite");
  if (entry.ocrText && entry.ocrText.trim()) {
    const ask = el("button", "paper-button primary", "Ask LINAW about this");
    ask.type = "button";
    ask.addEventListener("click", () => {
      setChatDocument({ id: entry.id, title: entry.title, text: entry.ocrText });
      goTo("assistant");
    });
    actions.append(ask);
  }
  if (entry.details?.dueDate) {
    const remind = el("button", "paper-button", "Remind me");
    remind.type = "button";
    remind.addEventListener("click", async () => {
      remind.disabled = true;
      try {
        actionFeedback.textContent = await addDueReminder(entry);
      } catch (error) {
        console.error(error);
        actionFeedback.textContent = "Could not save the reminder. Please try again.";
        remind.disabled = false;
      }
    });
    actions.append(remind);
  }
  if (actions.children.length) right.append(actions, actionFeedback);

  const text = document.createElement("pre");
  text.className = "viewer-text";
  text.textContent = entry.ocrText || "No text was saved for this entry.";
  right.append(text);

  leftPage.replaceChildren(left);
  rightPage.replaceChildren(right);
  right.scrollIntoView({ block: "start" });
  back.focus();
}

// Save a note reminding the user of a document's due date (once per document).
async function addDueReminder(entry) {
  const existing = (await store.all()).find(item => item.type === "note" && item.sourceId === entry.id);
  if (existing) return "This reminder is already in your notes.";
  const { dueDate, amount, issuer } = entry.details;
  const body = `${entry.title} is ${dueLabel(dueDate)} (${formatDate(dueDate)}).` +
    (amount ? ` Amount: ${amount}.` : "") + (issuer ? ` From ${issuer}.` : "");
  await store.add({ type: "note", title: `Pay: ${entry.title}`.slice(0, 100), category: "Notes", ocrText: body, dueDate, sourceId: entry.id });
  return "Reminder saved in your notes. Your home page shows what's due soon.";
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
// The saved document the chat is about ({ id, title, text }), or null for general questions.
let chatDocument = null;

// Switching to a different document (or back to none) starts a fresh conversation,
// so answers about one document never mix with another.
function setChatDocument(doc) {
  if ((chatDocument?.id ?? null) !== (doc?.id ?? null)) {
    conversation.length = 0;
    lumen.resetChat();
  }
  chatDocument = doc;
}

function renderChatContext() {
  const bar = document.getElementById("chatContext");
  if (!bar) return;
  bar.hidden = !chatDocument;
  document.getElementById("chatContextTitle").textContent = chatDocument?.title || "";
  const input = document.getElementById("chatInput");
  input.placeholder = chatDocument ? "Ask about this document, e.g. When is this due?" : "Write a question...";
  input.maxLength = chatCharCap();
  updateChatCounter();
}

// A question about a document leaves room in Lumen's message for the document excerpt.
function chatCharCap() {
  return chatDocument ? MAX_DOC_CHAT_CHARS : MAX_CHAT_CHARS;
}

// Words always; characters too once the question gets close to the character cap.
function updateChatCounter() {
  const input = document.getElementById("chatInput");
  const counter = document.getElementById("chatCounter");
  if (!input || !counter) return;
  const cap = chatCharCap();
  const chars = input.value.length;
  counter.textContent = `${countWords(input.value)} / ${MAX_CHAT_WORDS} words` +
    (chars >= cap * 0.75 ? ` · ${chars} / ${cap} characters` : "");
}

function bindAssistant() {
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const counter = document.getElementById("chatCounter");
  const status = document.getElementById("chatStatus");
  const send = document.getElementById("chatSend");

  renderChatContext();
  document.getElementById("chatContextClear").addEventListener("click", () => {
    setChatDocument(null);
    renderChatContext();
    renderConversation();
    status.textContent = "Now asking general questions. The previous conversation was cleared.";
    input.focus();
  });

  input.addEventListener("input", () => {
    if (countWords(input.value) > MAX_CHAT_WORDS) input.value = limitWords(input.value, MAX_CHAT_WORDS);
    const cap = chatCharCap();
    if (input.value.length > cap) input.value = input.value.slice(0, cap);
    updateChatCounter();
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
    if (message.length > chatCharCap()) {
      status.textContent = chatDocument
        ? `With a document attached, questions can be up to ${MAX_DOC_CHAT_CHARS} characters.`
        : `Please keep your question to ${MAX_CHAT_CHARS} characters.`;
      return;
    }

    conversation.push({ role: "user", message });
    input.value = "";
    updateChatCounter();
    status.textContent = "LINAW is thinking...";
    send.disabled = true;
    input.disabled = true;
    document.getElementById("chatContextClear").disabled = true;
    renderConversation(true);

    try {
      const reply = await lumen.chat(message, chatDocument);
      conversation.push({ role: "bot", message: reply.answer });
      status.textContent = reply.outOfScope
        ? "Lumen's assistant skipped that one. Try asking it a different way, e.g. \"What does amount due mean on my bill?\""
        : "";
    } catch (error) {
      // Take the unanswered question back out and return it to the box so it can be resent.
      conversation.pop();
      if (input.isConnected && !input.value) {
        input.value = message;
        updateChatCounter();
      }
      status.textContent = error.message || "Something went wrong. Please try again.";
    }
    send.disabled = false;
    input.disabled = false;
    const clearButton = document.getElementById("chatContextClear");
    if (clearButton) clearButton.disabled = false;
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
// (The LINAW logo is a plain link back to My Room, so it needs no handler here.)
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
