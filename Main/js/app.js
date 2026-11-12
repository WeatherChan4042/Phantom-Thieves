// Bookmark order controls the Previous/Next buttons and page indicator.
const pages = [
  { name: "home", accent: "coral" },
  { name: "collection", accent: "gold" },
  { name: "upload", accent: "green" },
  { name: "assistant", accent: "teal" },
  { name: "notes", accent: "plum" }
];

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

// Elements that remain in index.html while page content changes.
const bookArt = document.getElementById("bookArt");
const leftPage = document.getElementById("leftPage");
const rightPage = document.getElementById("rightPage");
const pageIndicator = document.getElementById("pageIndicator");
const prevButton = document.getElementById("prevButton");
const nextButton = document.getElementById("nextButton");
const pageLeafStage = document.getElementById("pageLeafStage");
const pageStack = document.getElementById("pageStack");
const pageCornerPrev = document.getElementById("pageCornerPrev");
const pageCornerNext = document.getElementById("pageCornerNext");
const bookmarks = [...document.querySelectorAll(".bookmark")];
const pageMarkupCache = new Map();
// Each adjacent pair has its own persistent two-sided sheet in the stack.
const pageTurnSheets = new Map();
let turnInProgress = false;

// Cache each page request so returning to a bookmark does not fetch it again.
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

// Load the selected HTML fragment, then update the book and play its page turn.
async function renderPage(index, animate = true) {
  const targetIndex = Math.max(0, Math.min(index, pages.length - 1));
  if (turnInProgress || targetIndex === currentPage) return;
  const page = pages[targetIndex];

  turnInProgress = true;
  setNavigationBusy(true);

  const leftMarkup = `
    <div class="left-leaf-note">
      <div class="leaf-emblem">L</div>
      <p class="leaf-kicker">A PERSONAL DOCUMENT JOURNAL</p>
      <h2>Keep what<br><em>matters.</em></h2>
      <p class="leaf-copy">A calmer place for everyday papers, useful details, and little things worth remembering.</p>
      <div class="leaf-footer">LINAW · EST. 2026</div>
    </div>`;

  try {
    if (animate) {
      const turnDirection = targetIndex > currentPage ? 1 : -1;
      const turnStartPage = currentPage;
      while (currentPage !== targetIndex) {
        const sheetIndex = turnDirection > 0 ? currentPage : currentPage - 1;
        let frontMarkup = await getPageMarkup(sheetIndex);
        let backMarkup = await getPageMarkup(sheetIndex + 1);
        if (turnDirection > 0 && sheetIndex === turnStartPage) frontMarkup = rightPage.innerHTML;
        if (turnDirection < 0 && sheetIndex + 1 === turnStartPage) backMarkup = rightPage.innerHTML;
        await animatePageLeaf(sheetIndex, frontMarkup, backMarkup, turnDirection);
        currentPage += turnDirection;
        rightPage.innerHTML = turnDirection > 0 ? backMarkup : frontMarkup;
        bookArt.dataset.accent = pages[currentPage].accent;
        updatePageStack();
      }
    } else {
      leftPage.innerHTML = leftMarkup;
      rightPage.innerHTML = await getPageMarkup(targetIndex);
      currentPage = targetIndex;
    }
    leftPage.innerHTML = leftMarkup;

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

function setNavigationBusy(busy) {
  bookArt.setAttribute("aria-busy", String(busy));
  prevButton.disabled = busy || currentPage <= 0;
  nextButton.disabled = busy || currentPage >= pages.length - 1;
  pageCornerPrev.disabled = busy || currentPage <= 0;
  pageCornerNext.disabled = busy || currentPage >= pages.length - 1;
  bookmarks.forEach(button => { button.disabled = busy; });
}

// Reuse the two-sided sheet for this page pair so the book keeps a real stack.
function animatePageLeaf(sheetIndex, frontMarkup, backMarkup, direction) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let leaf = pageTurnSheets.get(sheetIndex);
    if (!leaf) {
      leaf = document.createElement("div");
      leaf.className = "turning-leaf";
      leaf.dataset.sheet = String(sheetIndex);
      leaf.setAttribute("aria-hidden", "true");
      leaf.inert = true;
      const front = document.createElement("div");
      const back = document.createElement("div");
      const frontContent = document.createElement("div");
      const backContent = document.createElement("div");
      front.className = "leaf-face leaf-face-front";
      back.className = "leaf-face leaf-face-back";
      frontContent.className = "leaf-content";
      backContent.className = "leaf-content";
      front.append(frontContent);
      back.append(backContent);
      leaf.append(front, back);
      pageLeafStage.append(leaf);
      pageTurnSheets.set(sheetIndex, leaf);
    }
    leaf.querySelector(".leaf-face-front .leaf-content").innerHTML = frontMarkup;
    leaf.querySelector(".leaf-face-back .leaf-content").innerHTML = backMarkup;
    leaf.classList.remove("is-forward", "is-backward", "is-active");
    void leaf.offsetWidth;
    leaf.classList.add("is-active", direction < 0 ? "is-backward" : "is-forward");

    let finished = false;
    let fallbackTimer;
    const onAnimationEnd = event => {
      if (event.target === leaf) finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallbackTimer);
      leaf.removeEventListener("animationend", onAnimationEnd);
      leaf.classList.remove("is-active", "is-forward", "is-backward");
      resolve();
    };
    leaf.addEventListener("animationend", onAnimationEnd);
    // Keep navigation from getting stuck if a browser skips animationend.
    fallbackTimer = window.setTimeout(finish, 900);
  });
}

function updatePageStack() {
  const remainingPages = pages.length - currentPage - 1;
  pageStack.style.setProperty("--stack-depth", `${Math.max(0, remainingPages) * 1.1}px`);
  pageStack.classList.toggle("is-empty", remainingPages === 0);
}

// Keep the indicator, step buttons, document count, and bookmark in sync.
function updateBookNavigation(page) {
  pageIndicator.textContent = `${String(currentPage + 1).padStart(2, "0")} / ${String(pages.length).padStart(2, "0")}`;
  prevButton.disabled = currentPage === 0;
  nextButton.disabled = currentPage === pages.length - 1;
  pageCornerPrev.disabled = currentPage === 0;
  pageCornerNext.disabled = currentPage === pages.length - 1;
  updatePageStack();

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
pageCornerPrev.addEventListener("click", () => renderPage(currentPage - 1));
pageCornerNext.addEventListener("click", () => renderPage(currentPage + 1));

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

// Load the cover page without animating on the initial visit.
renderPage(0, false);



