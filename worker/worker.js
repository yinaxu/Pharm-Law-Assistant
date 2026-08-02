/**
 * Pharmacy Law Assistant — RAG API (v3)
 *
 * New in this version:
 *   - Ingestion splits documents on detected section markers (e.g. "§ 1306.11")
 *     so each stored chunk gets its OWN specific citation, instead of one
 *     generic label for an entire uploaded document.
 *   - Every chunk carries a `jurisdiction` ("Federal" or a state name). The
 *     answer prompt is instructed to flag it when a federal rule and a state
 *     rule (or two states) on the same topic actually disagree, and to say
 *     which one is more restrictive.
 *   - Each returned source now includes the full excerpt text plus a
 *     deterministically-picked "highlight" sentence (the sentence in that
 *     excerpt most relevant to the question), so the frontend can show
 *     exactly where the answer came from — and, for web sources, deep-link
 *     to that exact text on the live page via the browser's text-fragment
 *     highlighting (`#:~:text=`).
 *
 * Endpoints:
 *   POST /              — ask a question. Body: { question, jurisdictions? }
 *   POST /ingest/url     — [admin] scrape a page. Body: { url, jurisdiction?, citationPrefix?, citation? }
 *   POST /ingest/text    — [admin] store text. Body: { text, title, jurisdiction?, citationPrefix?, citation?, sourceUrl? }
 *   POST /ingest/reset   — [admin] wipe back to the seed corpus
 *   GET  /corpus         — public listing of what's indexed
 *   GET  /jurisdictions  — public list of distinct jurisdictions currently indexed
 *
 * Secrets required:
 *   wrangler secret put GEMINI_API_KEY
 *   wrangler secret put ADMIN_KEY
 */

// ---------------------------------------------------------------------------
// Seed corpus
// ---------------------------------------------------------------------------
const SEED_CORPUS = [
  {
    id: "corresponding-responsibility",
    citation: "21 CFR § 1306.04(a)",
    title: "Corresponding Responsibility for Controlled Substance Prescriptions",
    url: "https://www.ecfr.gov/current/title-21/chapter-II/part-1306/section-1306.04",
    jurisdiction: "Federal",
    text: "A prescription for a controlled substance is only effective if issued for a legitimate medical purpose by a practitioner acting in the usual course of professional practice. While the prescribing practitioner bears primary responsibility for proper prescribing, a corresponding responsibility rests on the pharmacist who fills the prescription. An order that doesn't meet this standard isn't a valid prescription, and both the issuing practitioner and a pharmacist who knowingly fills it can be held liable under federal law.",
  },
  {
    id: "schedule-ii-no-refills",
    citation: "21 CFR § 1306.12(a)",
    title: "Schedule II Prescriptions Cannot Be Refilled",
    url: "https://www.ecfr.gov/current/title-21/chapter-II/part-1306/subject-group-ECFR8588b52940237ef/section-1306.12",
    jurisdiction: "Federal",
    text: "Federal law flatly prohibits refilling a Schedule II controlled substance prescription. Each fill requires a new prescription — written, electronic, or (in a genuine emergency) an oral authorization followed by required paperwork. This is a bright-line federal rule; state law may add further restrictions such as expiration windows.",
  },
  {
    id: "schedule-ii-emergency-oral",
    citation: "21 CFR § 1306.11(d)",
    title: "Emergency Oral Prescriptions for Schedule II Drugs",
    url: "https://www.ecfr.gov/current/title-21/chapter-II/part-1306/subject-group-ECFR8588b52940237ef/section-1306.11",
    jurisdiction: "Federal",
    text: "In a genuine emergency, a pharmacist may dispense a Schedule II controlled substance based on the prescribing practitioner's oral authorization, provided the quantity is limited to what's needed to cover the emergency period. Within 7 days, the practitioner must deliver a written or electronic prescription for that emergency quantity, marked 'Authorization for Emergency Dispensing' with the date of the oral order. If that follow-up prescription never arrives, the pharmacist is required to notify the DEA.",
  },
  {
    id: "five-schedules",
    citation: "21 U.S.C. § 812",
    title: "The Five Controlled Substance Schedules",
    url: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title21-section812",
    jurisdiction: "Federal",
    text: "Federal law establishes five schedules — I through V — that classify controlled substances by abuse potential, accepted medical use, and dependence risk. Schedule I substances have no accepted medical use and the highest abuse potential; Schedule II substances have accepted medical use but still carry high abuse potential and may lead to severe dependence; Schedules III, IV, and V represent progressively lower abuse potential and dependence risk.",
  },
];

const SYSTEM_PROMPT = `You are a pharmacy law research assistant. Answer using ONLY the CONTEXT
excerpts provided in the user message. Every factual claim must trace back to
one of them.

- If the context doesn't cover the question, say so plainly and name what
  topic to ask about instead — never fall back on outside knowledge.
- This may be a follow-up to an earlier turn in the conversation. Resolve
  pronouns and implicit references against the prior turns — "what about in
  Alaska?" after a question about Schedule II refills means "does the same
  Schedule II refill rule apply in Alaska," not a brand-new, unrelated
  question. Answer the follow-up as a continuation, not in isolation.
- Only say the context "doesn't cover" the topic when nothing relevant is
  present at all. If the retrieved excerpts include a federal rule on the
  same topic but nothing state-specific for the state just asked about, say
  that plainly instead: state that no source specific to that state is
  loaded yet, but that the federal rule applies there too as a floor, and
  summarize what the federal rule says.
- Each excerpt is labeled with its jurisdiction (Federal, or a specific
  state). If two or more excerpts address the same topic and their
  jurisdictions genuinely disagree — federal vs. state, or state vs. state —
  explicitly flag it: name each jurisdiction's rule and state which one is
  more restrictive. As a general rule of thumb (not legal advice), federal
  law sets a floor and states may impose stricter requirements, and the
  stricter requirement is the one that actually governs. If the excerpts
  don't disagree, don't manufacture a comparison — just answer normally.
- Be precise and concise (aim for 3–6 sentences, more only if a genuine
  jurisdiction conflict needs spelling out).
- Do not list source citations in your prose — the interface displays the
  exact sources separately. Just write the answer itself.
- This is educational information, not legal advice.
- After the answer, on its own final line, output exactly:
  FOLLOWUPS: [...]
  where [...] is a JSON array of 2-3 short, specific follow-up questions a
  user might reasonably ask next, grounded only in topics a pharmacy law
  knowledge base would plausibly cover (related sections, other schedules,
  other jurisdictions, related roles like technicians). If nothing sensible
  comes to mind, output FOLLOWUPS: [].`;

// ---------------------------------------------------------------------------
// Corpus storage (Cloudflare KV)
// ---------------------------------------------------------------------------
async function loadCorpus(env) {
  if (!env.CORPUS_KV) return SEED_CORPUS;
  const stored = await env.CORPUS_KV.get("corpus", "json");
  return stored && stored.length ? stored : SEED_CORPUS;
}

async function saveCorpus(env, corpus) {
  await env.CORPUS_KV.put("corpus", JSON.stringify(corpus));
}

function mergeCorpus(existing, additions) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const chunk of additions) byId.set(chunk.id, chunk);
  return Array.from(byId.values());
}

function slugify(s) {
  return (s || "source")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Section-aware splitting + chunking
//
// Regulatory text is organized by section markers like "§ 1306.11" (CFR) or
// "§ 812" (USC). Splitting on those FIRST — before generic length-based
// chunking — means every stored chunk inherits the specific section it
// actually came from, instead of one label for a whole scraped/uploaded doc.
// ---------------------------------------------------------------------------
const SECTION_PATTERN = /§\s?(\d{2,4}(?:\.\d{1,4})?[a-z]?)/g;

function splitIntoSections(text) {
  const matches = [...text.matchAll(SECTION_PATTERN)];
  if (matches.length < 1) return [{ sectionNumber: null, body: text }];
  const sections = [];
  // Keep any preamble before the first marker as its own unlabeled section
  if (matches[0].index > 0) {
    sections.push({ sectionNumber: null, body: text.slice(0, matches[0].index) });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections.push({ sectionNumber: matches[i][1], body: text.slice(start, end) });
  }
  return sections.filter((s) => s.body.trim().length > 30);
}

function chunkText(rawText, { maxLen = 900, overlap = 150, minLen = 60 } = {}) {
  const text = rawText.replace(/\s+/g, " ").trim();
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(". ", end);
      if (lastPeriod > start + maxLen * 0.5) end = lastPeriod + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece.length >= minLen) chunks.push(piece);
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

/**
 * Builds corpus entries from a raw text blob, auto-detecting per-section
 * citations where possible and falling back to a supplied label otherwise.
 */
function buildEntries(rawText, { idBase, title, url, jurisdiction, citationPrefix, fallbackCitation }) {
  const sections = splitIntoSections(rawText);
  const entries = [];
  let sIdx = 0;
  for (const sec of sections) {
    const pieces = chunkText(sec.body);
    for (let i = 0; i < pieces.length; i++) {
      const citation = sec.sectionNumber
        ? `${citationPrefix ? citationPrefix + " " : ""}§ ${sec.sectionNumber}`
        : fallbackCitation || title || url || "Uploaded source";
      entries.push({
        id: `${idBase}-${sIdx}-${i}`,
        citation,
        title: title || url || "Uploaded source",
        url: url || "",
        jurisdiction: jurisdiction || "Federal",
        text: pieces[i],
      });
    }
    sIdx++;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// HTML → plain text (Workers-native HTMLRewriter streaming parser)
// ---------------------------------------------------------------------------
async function extractTextFromHtml(response) {
  let text = "";
  let title = "";
  const rewriter = new HTMLRewriter()
    .on("title", { text(t) { title += t.text; } })
    .on("script, style, nav, header, footer, noscript", {
      element(el) { el.remove(); },
    })
    .on("body *", {
      text(t) {
        text += t.text;
        if (t.lastInTextNode) text += " ";
      },
    });
  const transformed = rewriter.transform(response);
  await transformed.text();
  return { text: text.trim(), title: title.trim() };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------
// Common words that pass the length>=3 filter but carry no topical meaning.
// Without this, "the," "are," "for," "what" etc. get counted by raw
// occurrence count in scoreChunk below — and a long, topically-irrelevant
// chunk that happens to repeat those words often can out-score a short,
// genuinely relevant one. That's exactly the failure mode behind "asking
// about controlled substances in Alaska returns nothing": a long, unrelated
// Alaska chunk racks up stopword hits plus the jurisdiction bonus, while a
// short federal chunk that's actually on-topic scores lower and falls out
// of the top results.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "that", "this", "what", "does", "with", "from",
  "have", "has", "will", "can", "could", "would", "should", "about", "into",
  "under", "over", "when", "where", "which", "who", "whom", "how", "why",
  "not", "but", "was", "were", "been", "being", "its", "their", "your",
  "you", "our", "out", "any", "all", "some", "than", "then", "also", "upon",
  "per", "each", "such", "these", "those", "there", "here", "just", "only",
]);

function tokenize(str) {
  return (str.toLowerCase().match(/[a-z0-9§.]+/g) || [])
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function scoreChunk(queryTokens, chunk) {
  const haystack = `${chunk.title} ${chunk.citation} ${chunk.text}`.toLowerCase();
  const jurisdiction = (chunk.jurisdiction || "Federal").toLowerCase();
  let score = 0;
  for (const t of queryTokens) {
    // Presence, not frequency — a topic word appearing once still counts
    // fully, and a chunk can't inflate its score just by being long and
    // repeating a word many times.
    if (haystack.includes(t)) score += 1;
    if (chunk.citation.toLowerCase().includes(t)) score += 3;
    if (chunk.title.toLowerCase().includes(t)) score += 1;
    // A token like "alaska" or "washington" in the question rewards chunks
    // actually tagged with that jurisdiction — but only as a tie-breaker on
    // top of real topical relevance, not a substitute for it.
    if (jurisdiction.includes(t)) score += 2;
  }
  return score;
}

function retrieve(corpus, queryTokens, k = 5) {
  if (queryTokens.length === 0) return [];
  return corpus
    .map((c) => ({ c, score: scoreChunk(queryTokens, c) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => ({ ...s.c, _score: s.score }));
}


// ---------------------------------------------------------------------------
// Confidence — derived from how strongly retrieval actually matched, not
// guessed after the fact. "green" needs both a strong top match and at
// least one corroborating chunk; "yellow" is a single so-so match; "red"
// covers weak or absent matches.
// ---------------------------------------------------------------------------
function computeConfidence(matches) {
  if (!matches.length) return "red";
  const top = matches[0]._score || 0;
  const strongCount = matches.filter((m) => (m._score || 0) >= 2).length;
  if (top >= 6 && strongCount >= 2) return "green";
  if (top >= 2) return "yellow";
  return "red";
}

// ---------------------------------------------------------------------------
// Pull the model-generated follow-up questions off the end of the answer.
// Deterministic and defensive: any malformed/missing FOLLOWUPS line just
// yields an empty list rather than breaking the response.
// ---------------------------------------------------------------------------
function extractFollowups(rawText) {
  const match = rawText.match(/\n?FOLLOWUPS:\s*(\[[\s\S]*\])\s*$/i);
  if (!match) return { answer: rawText.trim(), followups: [] };
  let followups = [];
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) {
      followups = parsed.filter((q) => typeof q === "string" && q.trim()).slice(0, 3);
    }
  } catch {
    followups = [];
  }
  const answer = rawText.slice(0, match.index).trim();
  return { answer, followups };
}

// ---------------------------------------------------------------------------
// Conversation history — client sends it back on every request (no server
// session state). Sanitized/capped defensively since it's user-supplied.
// ---------------------------------------------------------------------------
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-4) // at most the last 4 exchanges
    .map((h) => ({
      question: (h && h.question ? String(h.question) : "").trim().slice(0, 400),
      answer: (h && h.answer ? String(h.answer) : "").trim().slice(0, 800),
    }))
    .filter((h) => h.question && h.answer);
}

// A bare follow-up like "what about in Alaska?" carries almost no keyword
// signal on its own — tokenize() on it alone returns ["what", "about",
// "alaska"], which matches nothing. Folding in the tokens from the last
// couple of prior questions gives retrieval the topic words ("refill",
// "schedule", "emergency") the follow-up is implicitly asking about, without
// needing a separate query-rewrite API call.
function buildRetrievalTokens(question, history) {
  const own = tokenize(question);
  const priorTokens = history.slice(-2).flatMap((h) => tokenize(h.question));
  return expandTokens(Array.from(new Set([...own, ...priorTokens])));
}

// ---------------------------------------------------------------------------
// Terminology bridge — this is pure keyword matching, not semantic search,
// so a question phrased as "interchange" finds nothing in a statute that
// only ever says "substitution," even though they mean the same thing. This
// is a stopgap for known pharmacy-law term mismatches, not a general fix;
// real recall on unanticipated phrasing still needs embeddings eventually.
// ---------------------------------------------------------------------------
const SYNONYMS = {
  interchange: ["substitut"],
  interchangeable: ["substitut"],
  swap: ["substitut"],
  generic: ["substitut", "equivalent"],
  script: ["prescription"],
  scripts: ["prescriptions"],
  renew: ["refill"],
  renewal: ["refill"],
  tech: ["technician"],
  techs: ["technicians"],
  otc: ["nonprescription"],
  intern: ["pharmacist-intern", "interns"],
  supervise: ["supervision"],
  supervising: ["supervision"],
  ratio: ["staffing"],
  // "Controlled substance" is the umbrella legal term; regulatory text and
  // everyday questions often use one specific drug-class word instead
  // ("opioids," "narcotics") without ever saying the umbrella term. Link
  // them both directions so either phrasing finds the other's chunks.
  controlled: ["opioid", "opioids", "narcotic", "narcotics", "stimulant", "stimulants", "depressant", "depressants", "hallucinogen", "hallucinogens", "benzodiazepine", "benzodiazepines", "schedule"],
  opioid: ["controlled", "narcotic", "narcotics", "schedule"],
  opioids: ["controlled", "narcotic", "narcotics", "schedule"],
  narcotic: ["controlled", "opioid", "opioids", "schedule"],
  narcotics: ["controlled", "opioid", "opioids", "schedule"],
  benzo: ["benzodiazepine", "controlled"],
  benzos: ["benzodiazepine", "benzodiazepines", "controlled"],
  stimulant: ["controlled", "schedule"],
  stimulants: ["controlled", "schedule"],
};

function expandTokens(tokens) {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    if (SYNONYMS[t]) for (const syn of SYNONYMS[t]) expanded.add(syn);
  }
  return Array.from(expanded);
}

// ---------------------------------------------------------------------------
// Sentence-level highlight — deterministic, so it always matches the source
// text exactly (no risk of the model paraphrasing away from a real quote).
// ---------------------------------------------------------------------------
function splitSentences(text) {
  const found = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return (found && found.length ? found : [text]).map((s) => s.trim()).filter(Boolean);
}

function pickHighlight(chunkText, queryTokens) {
  const sentences = splitSentences(chunkText);
  let best = sentences[0] || chunkText.slice(0, 200);
  let bestScore = -1;
  for (const s of sentences) {
    const lower = s.toLowerCase();
    let score = 0;
    for (const t of queryTokens) if (lower.includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// "Did you mean...?" fallback for zero keyword matches.
//
// Pure keyword search has a hard ceiling: no amount of hand-written synonyms
// covers every way someone might phrase a question. Rather than dead-ending
// on "not found," send the model a bare list of what topics we actually have
// (titles/citations only — no excerpt text, so this can't be mistaken for a
// legal answer) and let it map the user's phrasing to the closest real
// topic, the way a person skimming a table of contents would.
// ---------------------------------------------------------------------------
async function suggestRelatedTopics(question, corpus, env) {
  if (!env.GEMINI_API_KEY || corpus.length === 0) return [];

  const seen = new Map();
  for (const c of corpus) {
    const key = `${c.jurisdiction || "Federal"}|${c.citation}|${c.title}`;
    if (!seen.has(key)) seen.set(key, { jurisdiction: c.jurisdiction || "Federal", citation: c.citation, title: c.title });
  }
  const topics = Array.from(seen.values()).slice(0, 60);
  const topicList = topics.map((t, i) => `${i + 1}. (${t.jurisdiction}) ${t.citation} — ${t.title}`).join("\n");

  const prompt = `A pharmacy-law knowledge base has these topics indexed:\n${topicList}\n\n` +
    `A user asked: "${question}"\n\n` +
    `Nothing matched by keyword. If the user's wording plausibly maps to one or more of these topics — ` +
    `for example, they named a specific drug class ("opioids") that falls under a broader indexed category ` +
    `("controlled substances"), or used different terminology for the same concept — rewrite their intent as ` +
    `1-3 short questions phrased close to their own words but pointed at a topic that's actually indexed. ` +
    `If nothing plausibly relates, return an empty array. ` +
    `Respond with ONLY a JSON array of strings, nothing else.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 250 },
        }),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === "string" && q.trim()).slice(0, 3) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || "";
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}

// ---------------------------------------------------------------------------
// Question answering (Gemini)
// ---------------------------------------------------------------------------
async function answerQuestion(question, corpus, env, history = []) {
  const qTokens = tokenize(question);
  const retrievalTokens = buildRetrievalTokens(question, history);
  const matches = retrieve(corpus, retrievalTokens, 5);

  if (matches.length === 0) {
    const suggestions = await suggestRelatedTopics(question, corpus, env);
    const answer = suggestions.length
      ? `Nothing matches "${question}" directly by that wording. It might be filed under different terminology — try one of these instead:`
      : `That's outside this knowledge base right now (searched ${corpus.length} indexed ` +
        `chunk${corpus.length === 1 ? "" : "s"} in scope for this jurisdiction filter). Try ` +
        `different phrasing, or add a relevant source in the admin panel.`;
    return {
      answer,
      sources: [],
      confidence: "red",
      followups: suggestions,
    };
  }

  const contextBlock = matches
    .map((m, i) => `[${i + 1}] (${m.jurisdiction || "Federal"}) ${m.citation} — ${m.title}\n${m.text}`)
    .join("\n\n");

  if (!env.GEMINI_API_KEY) {
    throw new Error("Server misconfigured: GEMINI_API_KEY secret is not set.");
  }

  // Gemini model names change fairly often — check
  // https://ai.google.dev/gemini-api/docs/models if this ever 404s.
  const GEMINI_MODEL = "gemini-3.5-flash-lite";

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          // Prior turns, so the model can actually resolve "what about
          // Alaska?" against what was asked before — not just re-read the
          // isolated current question.
          ...history.flatMap((h) => [
            { role: "user", parts: [{ text: h.question }] },
            { role: "model", parts: [{ text: h.answer }] },
          ]),
          {
            role: "user",
            parts: [{ text: `CONTEXT:\n${contextBlock}\n\nQUESTION: ${question}` }],
          },
        ],
        generationConfig: { maxOutputTokens: 800 },
      }),
    }
  );

  if (!geminiRes.ok) {
    const detail = await geminiRes.text();
    throw new Error(`Upstream API error: ${detail}`);
  }

  const data = await geminiRes.json();
  const rawAnswer = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  const { answer, followups } = extractFollowups(rawAnswer);
  const confidence = computeConfidence(matches);

  const sources = matches.map((m) => {
    const highlight = pickHighlight(m.text, qTokens);
    const deepLink = m.url ? `${m.url}#:~:text=${encodeURIComponent(highlight.slice(0, 150))}` : "";
    return {
      citation: m.citation,
      title: m.title,
      url: m.url,
      jurisdiction: m.jurisdiction || "Federal",
      text: m.text,
      highlight,
      deepLink,
    };
  });

  return { answer, sources, confidence, followups };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // GET /corpus — public listing
    if (url.pathname === "/corpus" && request.method === "GET") {
      const corpus = await loadCorpus(env);
      return json({
        count: corpus.length,
        items: corpus.map((c) => ({
          id: c.id,
          citation: c.citation,
          title: c.title,
          url: c.url,
          jurisdiction: c.jurisdiction || "Federal",
        })),
      });
    }

    // GET /jurisdictions — public list of distinct jurisdictions indexed
    if (url.pathname === "/jurisdictions" && request.method === "GET") {
      const corpus = await loadCorpus(env);
      const set = new Set(corpus.map((c) => c.jurisdiction || "Federal"));
      return json({ jurisdictions: Array.from(set).sort() });
    }

    // POST /ingest/url — [admin] scrape a page and add it to the corpus
    if (url.pathname === "/ingest/url" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const targetUrl = (body.url || "").trim();
      if (!targetUrl) return json({ error: 'Missing "url"' }, 400);

      let pageRes;
      try {
        pageRes = await fetch(targetUrl, {
          headers: { "User-Agent": "PharmLawAssistantBot/1.0 (portfolio project; admin-triggered)" },
        });
      } catch (err) {
        return json({ error: "Could not fetch that URL", detail: String(err) }, 502);
      }
      if (!pageRes.ok) {
        return json({ error: `Fetch failed with HTTP ${pageRes.status}` }, 502);
      }

      const { text, title } = await extractTextFromHtml(pageRes);
      if (!text || text.length < 100) {
        return json({ error: "Couldn't find meaningful text on that page." }, 422);
      }

      const additions = buildEntries(text, {
        idBase: slugify(targetUrl),
        title,
        url: targetUrl,
        jurisdiction: body.jurisdiction || "Federal",
        citationPrefix: body.citationPrefix || "",
        fallbackCitation: body.citation || "",
      });

      const corpus = await loadCorpus(env);
      const merged = mergeCorpus(corpus, additions);
      await saveCorpus(env, merged);

      const specific = additions.filter((a) => a.citation.includes("§")).length;
      return json({
        added: additions.length,
        specificSections: specific,
        totalChunks: merged.length,
        title,
      });
    }

    // POST /ingest/text — [admin] add text extracted from an uploaded file
    if (url.pathname === "/ingest/text" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const text = (body.text || "").trim();
      if (!text) return json({ error: 'Missing "text"' }, 400);

      const title = body.title || "Uploaded document";
      const additions = buildEntries(text, {
        idBase: `${slugify(title)}-${Date.now()}`,
        title,
        url: body.sourceUrl || "",
        jurisdiction: body.jurisdiction || "Federal",
        citationPrefix: body.citationPrefix || "",
        fallbackCitation: body.citation || "",
      });

      const corpus = await loadCorpus(env);
      const merged = mergeCorpus(corpus, additions);
      await saveCorpus(env, merged);

      const specific = additions.filter((a) => a.citation.includes("§")).length;
      return json({ added: additions.length, specificSections: specific, totalChunks: merged.length });
    }

    // POST /ingest/reset — [admin] wipe back to the seed corpus
    if (url.pathname === "/ingest/reset" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      await saveCorpus(env, SEED_CORPUS);
      return json({ ok: true, totalChunks: SEED_CORPUS.length });
    }

    // POST / — ask a question
    if (url.pathname === "/" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const question = (body.question || "").toString().trim().slice(0, 500);
      if (!question) return json({ error: 'Missing "question"' }, 400);

      const history = sanitizeHistory(body.history);
      const corpus = await loadCorpus(env);

      let pool = corpus;
      if (Array.isArray(body.jurisdictions) && body.jurisdictions.length) {
        const allowed = new Set(body.jurisdictions);
        allowed.add("Federal"); // federal law always applies as a floor
        pool = corpus.filter((c) => allowed.has(c.jurisdiction || "Federal"));
      }

      try {
        const result = await answerQuestion(question, pool, env, history);
        return json(result);
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
