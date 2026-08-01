// ---------------------------------------------------------------------
// Point this at your deployed Cloudflare Worker (see worker/README).
// Example: "https://pharmlaw-rag-api.<your-subdomain>.workers.dev"
// ---------------------------------------------------------------------
const WORKER_URL = "https://pharmlaw-rag-api.pharmdev.workers.dev";

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSubmit = document.getElementById("chat-submit");
const demoNote = document.getElementById("demo-note");

function el(tag, className, text) {
  const node = document.createElement("div");
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addQuestion(text) {
  const wrap = el("div", "msg msg-question", text);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addAnswer(answerText, sources, isError = false) {
  const wrap = el("div", "msg msg-answer" + (isError ? " msg-error" : ""));
  const answer = el("div", "answer-text", answerText);
  wrap.appendChild(answer);

  if (sources && sources.length) {
    const sourcesRow = el("div", "sources");
    sources.forEach((s) => {
      const chip = document.createElement("a");
      chip.className = "source-chip";
      chip.href = s.url;
      chip.target = "_blank";
      chip.rel = "noopener";
      chip.textContent = s.citation;
      chip.title = s.title;
      sourcesRow.appendChild(chip);
    });
    wrap.appendChild(sourcesRow);
  }

  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function ask(question) {
  chatSubmit.disabled = true;
  demoNote.textContent = "Retrieving relevant sections…";

  if (!WORKER_URL || WORKER_URL.includes("YOUR-SUBDOMAIN")) {
    addAnswer(
      "This demo isn't wired up to a live backend yet — the page owner needs to deploy the Worker in /worker and set WORKER_URL in script.js. See worker/README for the two-command deploy.",
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
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    if (!res.ok) {
      addAnswer(data.error || "Something went wrong on the server.", [], true);
    } else {
      addAnswer(data.answer, data.sources);
    }
  } catch (err) {
    addAnswer("Couldn't reach the API. Check your connection and try again.", [], true);
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
