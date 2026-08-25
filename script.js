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
    countEl.textContent = `${data.count} source${data.count === 1 ? "" : "s"} loaded`;
  } catch {
    countEl.textContent = "";
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

  const answer = el("div", "answer-text");
  answer.innerHTML = formatAnswerHtml(answerText);
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

// Escapes a line of model output, then turns **bold** into <strong>. The
// model is instructed to only ever use ** for that one purpose.
function inlineFormat(str) {
  return escapeHtml(str).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// Turns the model's plain-text answer into HTML. The model is instructed to
// use "### " for an optional section heading, "- " for a bullet item, and
// blank lines between blocks — this walks line by line rather than assuming
// perfect blank-line placement, so it stays robust either way.
function formatAnswerHtml(rawText) {
  const text = (rawText || "").trim();
  if (!text) return "";

  let html = "";
  let listBuffer = [];
  let paraBuffer = [];

  function flushList() {
    if (listBuffer.length) {
      html += `<ul class="answer-list">${listBuffer
        .map((l) => `<li>${inlineFormat(l)}</li>`)
        .join("")}</ul>`;
      listBuffer = [];
    }
  }
  function flushPara() {
    if (paraBuffer.length) {
      html += `<p>${paraBuffer.map(inlineFormat).join("<br>")}</p>`;
      paraBuffer = [];
    }
  }

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushList();
      flushPara();
      continue;
    }
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) {
      flushList();
      flushPara();
      html += `<h4 class="answer-heading">${inlineFormat(heading[1])}</h4>`;
      continue;
    }
    const bullet = line.match(/^[-•]\s+(.*)$/);
    if (bullet) {
      flushPara();
      listBuffer.push(bullet[1]);
      continue;
    }
    flushList();
    paraBuffer.push(line);
  }
  flushList();
  flushPara();
  return html;
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

// ---------------------------------------------------------------------
// Compare states
// ---------------------------------------------------------------------
const compareSelectA = document.getElementById("compare-select-a");
const compareSelectB = document.getElementById("compare-select-b");
const compareForm = document.getElementById("compare-form");
const compareInput = document.getElementById("compare-input");
const compareSubmit = document.getElementById("compare-submit");
const compareNote = document.getElementById("compare-note");
const compareResults = document.getElementById("compare-results");

async function initCompare() {
  if (!isConfigured()) {
    compareNote.textContent = "This demo isn't wired up to a live backend yet. See DEPLOY.md.";
    compareForm.querySelectorAll("input, button").forEach((n) => (n.disabled = true));
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL}/jurisdictions`);
    const data = await res.json();
    const jurisdictions = (data.jurisdictions && data.jurisdictions.length)
      ? data.jurisdictions
      : ["Federal"];
    fillCompareSelect(compareSelectA, jurisdictions, 0);
    fillCompareSelect(compareSelectB, jurisdictions, jurisdictions.length > 1 ? 1 : 0);
    compareNote.textContent = jurisdictions.length > 1
      ? "Only jurisdictions with real sources loaded will show a meaningful difference."
      : "Only federal law is loaded so far. Add a state's regulations in the admin panel to compare them here.";
  } catch {
    fillCompareSelect(compareSelectA, ["Federal"], 0);
    fillCompareSelect(compareSelectB, ["Federal"], 0);
    compareNote.textContent = "Couldn't load the list of jurisdictions.";
  }
}

function fillCompareSelect(selectEl, jurisdictions, defaultIndex) {
  selectEl.innerHTML = jurisdictions
    .map((j) => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`)
    .join("");
  selectEl.selectedIndex = defaultIndex;
}

function renderCompareColumn(titleEl, bodyEl, jurisdictionLabel) {
  titleEl.textContent = jurisdictionLabel;
  bodyEl.innerHTML = '<p class="compare-loading">Checking the law…</p>';
}

async function fetchCompareAnswer(question, jurisdiction) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, jurisdictions: [jurisdiction] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function paintCompareColumn(bodyEl, data) {
  bodyEl.innerHTML = "";
  const answerDiv = el("div", "compare-answer-text");
  answerDiv.innerHTML = formatAnswerHtml(data.answer);
  bodyEl.appendChild(answerDiv);
  if (data.sources && data.sources.length) {
    const chipRow = el("div", "compare-source-chips");
    data.sources.forEach((s) => {
      chipRow.appendChild(el("span", "compare-source-chip", s.citation));
    });
    bodyEl.appendChild(chipRow);
  }
}

compareForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = compareInput.value.trim();
  if (!question) return;
  if (!isConfigured()) return;

  const jurA = compareSelectA.value;
  const jurB = compareSelectB.value;

  compareResults.hidden = false;
  compareSubmit.disabled = true;
  renderCompareColumn(document.getElementById("compare-title-a"), document.getElementById("compare-body-a"), jurA);
  renderCompareColumn(document.getElementById("compare-title-b"), document.getElementById("compare-body-b"), jurB);

  const [resultA, resultB] = await Promise.allSettled([
    fetchCompareAnswer(question, jurA),
    fetchCompareAnswer(question, jurB),
  ]);

  const bodyA = document.getElementById("compare-body-a");
  const bodyB = document.getElementById("compare-body-b");

  if (resultA.status === "fulfilled") {
    paintCompareColumn(bodyA, resultA.value);
  } else {
    bodyA.innerHTML = "";
    bodyA.appendChild(el("div", "compare-answer-text", "Couldn't get an answer for this side. Try again."));
  }

  if (resultB.status === "fulfilled") {
    paintCompareColumn(bodyB, resultB.value);
  } else {
    bodyB.innerHTML = "";
    bodyB.appendChild(el("div", "compare-answer-text", "Couldn't get an answer for this side. Try again."));
  }

  compareSubmit.disabled = false;
});

loadJurisdictions();
loadCorpusCount();
initCompare();
