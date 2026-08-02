// ---------------------------------------------------------------------
// Point this at your deployed Cloudflare Worker (see DEPLOY.md).
// Example: "https://pharmlaw-rag-api.<your-subdomain>.workers.dev"
// ---------------------------------------------------------------------
const WORKER_URL = "https://pharmlaw-rag-api.pharmdev.workers.dev";

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSubmit = document.getElementById("chat-submit");
const demoNote = document.getElementById("demo-note");
const jurisdictionRow = document.getElementById("jurisdiction-row");

const inspectorOverlay = document.getElementById("inspector-overlay");
const inspectorTitle = document.getElementById("inspector-title");
const inspectorMeta = document.getElementById("inspector-meta");
const inspectorExcerpt = document.getElementById("inspector-excerpt");
const inspectorLinks = document.getElementById("inspector-links");

let activeJurisdictions = new Set(); // empty = no filter, search everything
let conversationHistory = []; // session-only, resets on reload — sent back to the API each turn

function el(tag, className, text) {
  const node = document.createElement("div");
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isConfigured() {
  return WORKER_URL && !WORKER_URL.includes("YOUR-SUBDOMAIN");
}

// ---------------------------------------------------------------------
// Jurisdiction filter chips
// ---------------------------------------------------------------------
async function loadJurisdictions() {
  if (!isConfigured()) return;
  try {
    const res = await fetch(`${WORKER_URL}/jurisdictions`);
    const data = await res.json();
    renderJurisdictionChips(data.jurisdictions || ["Federal"]);
  } catch {
    renderJurisdictionChips(["Federal"]);
  }
}

async function loadCorpusCount() {
  const countEl = document.getElementById("corpus-count");
  if (!isConfigured()) {
    countEl.textContent = "demo not configured";
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL}/corpus`);
    const data = await res.json();
    countEl.textContent = `${data.count} chunk${data.count === 1 ? "" : "s"} indexed`;
  } catch {
    countEl.textContent = "";
  }
}

async function loadSourceList() {
  const listEl = document.getElementById("source-list");
  if (!isConfigured()) {
    listEl.innerHTML = '<span class="jurisdiction-label">Demo not configured yet.</span>';
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL}/corpus`);
    const data = await res.json();
    // De-duplicate down to one entry per (title, url) pair so a document
    // split into many sections shows once, not once per section.
    const seen = new Map();
    for (const item of data.items) {
      const key = `${item.title}|${item.url}`;
      if (!seen.has(key)) seen.set(key, item);
    }
    const unique = Array.from(seen.values());
    if (unique.length === 0) {
      listEl.innerHTML = '<span class="jurisdiction-label">Nothing indexed yet.</span>';
      return;
    }
    listEl.innerHTML = unique
      .map((item) => {
        const label = `${item.jurisdiction || "Federal"} — ${item.title}`;
        return item.url
          ? `<a class="source-pill" href="${item.url}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
          : `<span class="source-pill">${escapeHtml(label)}</span>`;
      })
      .join("");
  } catch {
    listEl.innerHTML = '<span class="jurisdiction-label">Couldn\'t load sources.</span>';
  }
}

function renderJurisdictionChips(jurisdictions) {
  const label = jurisdictionRow.querySelector(".jurisdiction-label");
  jurisdictionRow.innerHTML = "";
  jurisdictionRow.appendChild(label || el("span", "jurisdiction-label", "Jurisdiction:"));

  const stateJurisdictions = jurisdictions.filter((j) => j !== "Federal");
  stateJurisdictions.forEach((j) => {
    activeJurisdictions.add(j);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "jur-chip active";
    chip.textContent = j;
    chip.dataset.jurisdiction = j;
    chip.setAttribute("aria-pressed", "true");
    chip.title = `Click to leave ${j} out of the search`;
    chip.addEventListener("click", () => {
      if (activeJurisdictions.has(j)) {
        activeJurisdictions.delete(j);
        chip.classList.remove("active");
        chip.setAttribute("aria-pressed", "false");
        chip.title = `Click to include ${j} in the search`;
      } else {
        activeJurisdictions.add(j);
        chip.classList.add("active");
        chip.setAttribute("aria-pressed", "true");
        chip.title = `Click to leave ${j} out of the search`;
      }
    });
    jurisdictionRow.appendChild(chip);
  });
}

// ---------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------
function addQuestion(text) {
  const wrap = el("div", "msg msg-question", text);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function confidenceLabel(level) {
  switch (level) {
    case "green": return "High confidence";
    case "yellow": return "Partial answer";
    case "red": return "Limited information";
    default: return null;
  }
}

function addAnswer(answerText, sources, confidence, followups, isError = false) {
  const wrap = el("div", "msg msg-answer" + (isError ? " msg-error" : ""));

  const label = !isError ? confidenceLabel(confidence) : null;
  if (label) {
    const row = el("div", "answer-row");
    const badge = document.createElement("span");
    badge.className = `confidence-badge conf-${confidence}`;
    badge.textContent = label;
    row.appendChild(badge);
    wrap.appendChild(row);
  }

  const answer = el("div", "answer-text", answerText);
  wrap.appendChild(answer);

  if (sources && sources.length) {
    const panel = el("div", "sources-panel");
    panel.appendChild(el("div", "sources-title", "Sources"));
    sources.forEach((s, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "source-row";
      row.title = "Click to view the exact excerpt";
      const check = el("span", "source-check", "✓");
      const num = el("span", "", `[${i + 1}]`);
      const citation = el("span", "source-citation", s.citation);
      row.appendChild(check);
      row.appendChild(num);
      row.appendChild(citation);
      row.addEventListener("click", () => openInspector(s));
      panel.appendChild(row);
    });
    wrap.appendChild(panel);
  }

  if (followups && followups.length) {
    const panel = el("div", "followups-panel");
    panel.appendChild(el("div", "followups-title", "Related questions"));
    followups.forEach((q) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "followup-chip";
      chip.textContent = q;
      chip.addEventListener("click", () => {
        chatInput.value = q;
        chatForm.dispatchEvent(new Event("submit"));
      });
      panel.appendChild(chip);
    });
    wrap.appendChild(panel);
  }

  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------------------------------------------------------------------
// Source inspector modal
// ---------------------------------------------------------------------
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function openInspector(source) {
  inspectorTitle.textContent = source.citation;

  const jurClass = source.jurisdiction === "Federal" ? "fed" : "state";
  inspectorMeta.innerHTML = `<span class="jurisdiction-badge ${jurClass}">${escapeHtml(source.jurisdiction || "Federal")}</span>${escapeHtml(source.title || "")}`;

  let excerptHtml = escapeHtml(source.text || "");
  if (source.highlight) {
    const h = escapeHtml(source.highlight);
    const plain = escapeHtml(source.text || "");
    if (plain.includes(h)) {
      excerptHtml = plain.replace(h, `<mark>${h}</mark>`);
    }
  }
  inspectorExcerpt.innerHTML = excerptHtml;

  inspectorLinks.innerHTML = "";
  if (source.deepLink) {
    const a = document.createElement("a");
    a.href = source.deepLink;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open exact passage on source page ↗";
    inspectorLinks.appendChild(a);
  } else if (source.url) {
    const a = document.createElement("a");
    a.href = source.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open source page ↗";
    inspectorLinks.appendChild(a);
  }

  inspectorOverlay.classList.add("open");
}

function closeInspector() {
  inspectorOverlay.classList.remove("open");
}

document.getElementById("inspector-close").addEventListener("click", closeInspector);
inspectorOverlay.addEventListener("click", (e) => {
  if (e.target === inspectorOverlay) closeInspector();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeInspector();
});

// ---------------------------------------------------------------------
// Asking questions
// ---------------------------------------------------------------------
async function ask(question) {
  chatSubmit.disabled = true;
  demoNote.textContent = "Retrieving relevant sections…";

  if (!isConfigured()) {
    addAnswer(
      "This demo isn't wired up to a live backend yet — the page owner needs to deploy the Worker in /worker and set WORKER_URL in script.js. See DEPLOY.md for the walkthrough.",
      [],
      null,
      [],
      true
    );
    chatSubmit.disabled = false;
    demoNote.textContent = "";
    return;
  }

  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        jurisdictions: Array.from(activeJurisdictions),
        history: conversationHistory.slice(-3),
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      addAnswer(data.error || "Something went wrong on the server.", [], null, [], true);
    } else {
      addAnswer(data.answer, data.sources, data.confidence, data.followups);
      conversationHistory.push({ question, answer: data.answer });
      if (conversationHistory.length > 6) conversationHistory.shift();
    }
  } catch (err) {
    addAnswer("Couldn't reach the API. Check your connection and try again.", [], null, [], true);
  } finally {
    chatSubmit.disabled = false;
    demoNote.textContent = "";
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  addQuestion(question);
  chatInput.value = "";
  ask(question);
});

document.querySelectorAll(".sample-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const q = btn.getAttribute("data-q");
    chatInput.value = q;
    chatForm.dispatchEvent(new Event("submit"));
  });
});

loadJurisdictions();
loadCorpusCount();
loadSourceList();
