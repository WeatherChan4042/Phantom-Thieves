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
const demoDocuments = [
  { name: "Electricity bill - sample.pdf", category: "Bills", date: "Sample entry" },
  { name: "Grocery receipt - sample.jpg", category: "Receipts", date: "Sample entry" },
  { name: "Personal information form.pdf", category: "Personal", date: "Sample entry" }
];
const demoNotes = [];
const demoConversation = [
  {
    role: "bot",
    message: "Hello! I can help explain a document in simpler words. Choose a sample question to preview the conversation."
  }
];

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
  bindPageInteractions(page.name);
  if (page.name === "collection") renderDocuments();
  if (page.name === "assistant") renderConversation();
  if (page.name === "notes") renderNotes();
}

// Get a page's markup, or a friendly error message if it could not be fetched.
async function getPageMarkup(index) {
  const page = pages[index];
  try {
    return await loadPageMarkup(page.name);
  } catch (error) {
    pageMarkupCache.delete(page.name);
    console.error(error);
    return '<p class="page-lead page-load-error" role="alert">This page could not load. Open LINAW through a local web server and try again.</p>';
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

  const homeCount = document.getElementById("homeDocCount");
  if (homeCount) homeCount.textContent = demoDocuments.length;

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

  // File selection and drop handling for New Entry.
  if (name === "upload") {
    const input = document.getElementById("fileInput");
    const zone = document.getElementById("dropZone");
    const feedback = document.getElementById("fileFeedback");
    const save = document.getElementById("saveDocument");
    let selectedFile = null;

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

    // Check the chosen file's type and size, then enable or disable the Save button.
    function chooseFile(file) {
      if (!file) return;
      const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
      const allowedExtension = /\.(pdf|jpe?g|png)$/i.test(file.name);
      if (!allowedTypes.includes(file.type) && !allowedExtension) {
        feedback.textContent = "Please choose a PDF, JPG, or PNG file.";
        selectedFile = null;
        save.disabled = true;
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        feedback.textContent = "That file is larger than 10 MB. Please choose a smaller file.";
        selectedFile = null;
        save.disabled = true;
        return;
      }
      selectedFile = file;
      feedback.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB selected.`;
      save.disabled = false;
    }

    save.addEventListener("click", () => {
      if (!selectedFile) return;
      demoDocuments.unshift({
        name: selectedFile.name,
        category: document.getElementById("categorySelect").value,
        date: "Just added · local demo"
      });
      selectedFile = null;
      input.value = "";
      goTo("collection");
    });
  }

  // Search and category filters for Collection.
  if (name === "collection") {
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

  // Sample prompts and replies for Ask LINAW.
  if (name === "assistant") {
    document.querySelectorAll(".prompt-chip").forEach(chip => {
      chip.addEventListener("click", () => sendDemoMessage(chip.textContent));
    });
    document.getElementById("chatForm").addEventListener("submit", event => {
      event.preventDefault();
      const input = document.getElementById("chatInput");
      if (!input.value.trim()) return;
      sendDemoMessage(input.value.trim());
      input.value = "";
    });
  }

  // Save notes in memory so they stay available while browsing the book.
  if (name === "notes") {
    document.getElementById("saveNote").addEventListener("click", () => {
      const titleInput = document.getElementById("noteTitle");
      const bodyInput = document.getElementById("noteBody");
      const feedback = document.getElementById("noteFeedback");
      const title = titleInput.value.trim();
      const body = bodyInput.value.trim();
      if (!title || !body) {
        feedback.textContent = "Add a title and a note before saving.";
        (title ? bodyInput : titleInput).focus();
        return;
      }

      demoNotes.unshift({ title, body });
      renderNotes();
      feedback.textContent = "Note saved for this visit.";
      titleInput.value = "";
      bodyInput.value = "";
    });
  }
}

// Highlight the active category chip in the Collection page.
function updateFilterControls() {
  document.querySelectorAll(".filter-chip").forEach(chip => {
    const selected = chip.dataset.filter === activeFilter;
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
}

// Draw the filtered list using text nodes for document names.
function renderDocuments() {
  const list = document.getElementById("documentList");
  if (!list) return;
  const query = collectionQuery.trim().toLowerCase();
  const matchingDocuments = demoDocuments.filter(document =>
    (activeFilter === "All" || document.category === activeFilter) &&
    document.name.toLowerCase().includes(query)
  );

  list.replaceChildren();
  if (!matchingDocuments.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No documents match your search and category.";
    list.append(emptyState);
    return;
  }

  matchingDocuments.forEach(entry => {
    const row = document.createElement("div");
    row.className = "doc-row";
    const icon = document.createElement("div");
    icon.className = "doc-icon";
    icon.textContent = entry.name.toLowerCase().endsWith(".pdf") ? "▤" : "▧";
    const meta = document.createElement("div");
    meta.className = "doc-meta";
    const title = document.createElement("strong");
    title.textContent = entry.name;
    const detail = document.createElement("small");
    detail.textContent = `${entry.category} · ${entry.date}`;
    meta.append(title, detail);
    row.append(icon, meta);
    list.append(row);
  });

  const count = document.getElementById("homeDocCount");
  if (count) count.textContent = demoDocuments.length;
}

// Draw the saved notes, or a friendly empty message when there are none.
function renderNotes() {
  const list = document.getElementById("savedNotes");
  if (!list) return;
  list.replaceChildren();

  if (!demoNotes.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "Your saved notes will appear here.";
    list.append(emptyState);
    return;
  }

  demoNotes.forEach(({ title, body }) => {
    const note = document.createElement("div");
    note.className = "saved-note";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const content = document.createElement("div");
    content.textContent = body;
    note.append(heading, content);
    list.append(note);
  });
}

// Draw the chat bubbles and scroll to the newest message.
function renderConversation() {
  const chat = document.getElementById("chatMessages");
  if (!chat) return;
  chat.replaceChildren();

  demoConversation.forEach(({ role, message }) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;
    bubble.textContent = message;
    chat.append(bubble);
  });
  chat.scrollTop = chat.scrollHeight;
}

// Add a sample user message and a fixed prototype response.
function sendDemoMessage(message) {
  demoConversation.push({ role: "user", message });
  demoConversation.push({
    role: "bot",
    message:
      "This is a preview response. Once Lumen AI is connected, LINAW will answer " +
      "using the selected document and point you to the relevant information."
  });
  renderConversation();
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
