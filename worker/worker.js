/**
 * Pharmacy Law Assistant — RAG API (v4 Vectorize Engine)
 *
 * Architecture Improvements:
 *   - Semantic Retrieval: Replaced lexical token-matching with Cloudflare Vectorize
 *     and Workers AI (@cf/baai/bge-small-en-v1.5) embeddings.
 *   - Section-aware splitting remains intact to maintain section-level citations.
 *   - Dual Storage Pattern:
 *       1. High-dimensional vectors are indexed in env.VECTOR_INDEX (Vectorize).
 *       2. Structural chunk metadata and raw text remain in env.CORPUS_KV.
 *
 * Endpoints:
 *   POST /              — ask a question. Body: { question, jurisdictions? }
 *   POST /ingest/url     — [admin] scrape a page. Body: { url, jurisdiction?, citationPrefix?, citation? }
 *   POST /ingest/text    — [admin] store text. Body: { text, title, jurisdiction?, citationPrefix?, citation?, sourceUrl? }
 *   POST /ingest/reset   — [admin] wipe back to seed corpus
 *   GET  /corpus         — public listing of indexed chunks
 *   GET  /jurisdictions  — public list of indexed jurisdictions
 */

// ---------------------------------------------------------------------------
// Seed Corpus (Default fallback prior to dynamic vector ingestion)
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
- Draw logical inferences: connect natural language terms (e.g. "write prescriptions", "prescribe") to statutory terms (e.g. "initiating or modifying drug therapy", "prescriptive authority").
- This may be a follow-up to an earlier turn in the conversation. Resolve
  pronouns and implicit references against the prior turns.
- Each excerpt is labeled with its jurisdiction (Federal, or a specific state).
  If two or more excerpts address the same topic and their jurisdictions disagree,
  explicitly flag it and state which rule is more restrictive.
- Be precise, concise, and clear (3–6 sentences).
- Do not list source citations in your prose; the interface displays sources separately.
- Educational information only; not legal advice.
- After the answer, on its own final line, output exactly:
  FOLLOWUPS: [...]
  where [...] is a JSON array of 2-3 short, specific follow-up questions.`;

// ---------------------------------------------------------------------------
// Text Processing & Chunking Utilities
// ---------------------------------------------------------------------------
const SECTION_PATTERN = /§\s?(\d{2,4}(?:\.\d{1,4})?[a-z]?)/g;

function splitIntoSections(text) {
  const matches = [...text.matchAll(SECTION_PATTERN)];
  if (matches.length < 1) return [{ sectionNumber: null, body: text }];
  const sections = [];
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

function slugify(s) {
  return (s || "source")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

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
// KV and Vectorize Storage Logic
// ---------------------------------------------------------------------------
async function loadCorpus(env) {
  if (!env.CORPUS_KV) return SEED_CORPUS;
  const stored = await env.CORPUS_KV.get("corpus", "json");
  return stored && stored.length ? stored : SEED_CORPUS;
}

/**
 * Embeds documents using Workers AI and stores vectors in Vectorize while
 * writing the document corpus to Workers KV.
 */
async function ingestEntries(entries, env) {
  if (!env.VECTOR_INDEX || !env.AI) {
    // Fallback if Vectorize/Workers AI binding isn't active
    const corpus = await loadCorpus(env);
    const byId = new Map(corpus.map((c) => [c.id, c]));
    for (const entry of entries) byId.set(entry.id, entry);
    const updated = Array.from(byId.values());
    await env.CORPUS_KV.put("corpus", JSON.stringify(updated));
    return;
  }

  const vectorsToInsert = [];
  for (const entry of entries) {
    // Generate text embedding vector (384 dimensions)
    const textToEmbed = `${entry.citation} ${entry.title} ${entry.text}`;
    const embedding = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: textToEmbed });

    vectorsToInsert.push({
      id: entry.id,
      values: embedding.data[0],
      metadata: {
        citation: entry.citation,
        title: entry.title,
        jurisdiction: entry.jurisdiction,
      },
    });
  }

  // 1. Store vectors in Vectorize
  await env.VECTOR_INDEX.insert(vectorsToInsert);

  // 2. Persist full document map in KV
  const corpus = await loadCorpus(env);
  const byId = new Map(corpus.map((c) => [c.id, c]));
  for (const entry of entries) byId.set(entry.id, entry);
  const updatedCorpus = Array.from(byId.values());

  await env.CORPUS_KV.put("corpus", JSON.stringify(updatedCorpus));
}

// ---------------------------------------------------------------------------
// Semantic Retrieval via Vector Similarity
// ---------------------------------------------------------------------------
async function retrieveContext(queryText, corpus, env, jurisdictions = []) {
  // Fallback to lexical search if Vectorize binding is absent
  if (!env.VECTOR_INDEX || !env.AI) {
    return corpus.slice(0, 5);
  }

  // 1. Embed incoming user query
  const queryEmbedding = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: queryText });

  // 2. Query Vectorize
  const matches = await env.VECTOR_INDEX.query(queryEmbedding.data[0], {
    topK: 8,
    returnMetadata: true,
  });

  if (!matches || !matches.matches || matches.matches.length === 0) {
    return [];
  }

  // 3. Map returned vector IDs back to KV stored corpus
  const corpusMap = new Map(corpus.map((item) => [item.id, item]));
  const allowedJurisdictions = jurisdictions.length
    ? new Set([...jurisdictions, "Federal"])
    : null;

  const results = [];
  for (const match of matches.matches) {
    const doc = corpusMap.get(match.id);
    if (doc) {
      if (!allowedJurisdictions || allowedJurisdictions.has(doc.jurisdiction || "Federal")) {
        results.push({ ...doc, _score: match.score });
      }
    }
  }

  return results.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Sentence Highlighting & Followups Helper
// ---------------------------------------------------------------------------
function splitSentences(text) {
  const found = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return (found && found.length ? found : [text]).map((s) => s.trim()).filter(Boolean);
}

function pickHighlight(chunkText, queryText) {
  const sentences = splitSentences(chunkText);
  const tokens = queryText.toLowerCase().match(/[a-z0-9]+/g) || [];
  let best = sentences[0] || chunkText.slice(0, 200);
  let bestScore = -1;
  for (const s of sentences) {
    const lower = s.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lower.includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

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

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-4)
    .map((h) => ({
      question: (h && h.question ? String(h.question) : "").trim().slice(0, 400),
      answer: (h && h.answer ? String(h.answer) : "").trim().slice(0, 800),
    }))
    .filter((h) => h.question && h.answer);
}

// ---------------------------------------------------------------------------
// Answering Engine
// ---------------------------------------------------------------------------
async function answerQuestion(question, corpus, env, history = [], jurisdictions = []) {
  const matches = await retrieveContext(question, corpus, env, jurisdictions);

  if (matches.length === 0) {
    return {
      answer: `No relevant documents were found for "${question}". Try expanding your jurisdiction filters or adding the statute in the admin panel.`,
      sources: [],
      confidence: "red",
      followups: [],
    };
  }

  const contextBlock = matches
    .map((m, i) => `[${i + 1}] (${m.jurisdiction || "Federal"}) ${m.citation} — ${m.title}\n${m.text}`)
    .join("\n\n");

  if (!env.GEMINI_API_KEY) {
    throw new Error("Server misconfigured: GEMINI_API_KEY secret is not set.");
  }

  const GEMINI_MODEL = "gemini-1.5-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          ...history.flatMap((h) => [
            { role: "user", parts: [{ text: h.question }] },
            { role: "model", parts: [{ text: h.answer }] },
          ]),
          {
            role: "user",
            parts: [{ text: `CONTEXT:\n${contextBlock}\n\nQUESTION: ${question}` }],
          },
        ],
        generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini API Error (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const rawAnswer = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  const { answer, followups } = extractFollowups(rawAnswer);

  const sources = matches.map((m) => {
    const highlight = pickHighlight(m.text, question);
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

  return { answer, sources, confidence: "green", followups };
}

// ---------------------------------------------------------------------------
// HTTP Router
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

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

    if (url.pathname === "/jurisdictions" && request.method === "GET") {
      const corpus = await loadCorpus(env);
      const set = new Set(corpus.map((c) => c.jurisdiction || "Federal"));
      return json({ jurisdictions: Array.from(set).sort() });
    }

    // Ingest URL route
    if (url.pathname === "/ingest/url" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      const targetUrl = (body.url || "").trim();
      if (!targetUrl) return json({ error: 'Missing "url"' }, 400);

      const pageRes = await fetch(targetUrl, {
        headers: { "User-Agent": "PharmLawAssistantBot/1.0" },
      });
      if (!pageRes.ok) return json({ error: `Fetch failed HTTP ${pageRes.status}` }, 502);

      const { text, title } = await extractTextFromHtml(pageRes);
      if (!text || text.length < 100) return json({ error: "Insufficient text found." }, 422);

      const additions = buildEntries(text, {
        idBase: slugify(targetUrl),
        title,
        url: targetUrl,
        jurisdiction: body.jurisdiction || "Federal",
        citationPrefix: body.citationPrefix || "",
        fallbackCitation: body.citation || "",
      });

      await ingestEntries(additions, env);
      const corpus = await loadCorpus(env);

      return json({ added: additions.length, totalChunks: corpus.length, title });
    }

    // Ingest Text route
    if (url.pathname === "/ingest/text" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
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

      await ingestEntries(additions, env);
      const corpus = await loadCorpus(env);

      return json({ added: additions.length, totalChunks: corpus.length });
    }

    // Reset Corpus route
    if (url.pathname === "/ingest/reset" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
      await env.CORPUS_KV.put("corpus", JSON.stringify(SEED_CORPUS));
      await ingestEntries(SEED_CORPUS, env);
      return json({ ok: true, totalChunks: SEED_CORPUS.length });
    }

    // Question route
    if (url.pathname === "/" && request.method === "POST") {
      const body = await request.json();
      const question = (body.question || "").toString().trim().slice(0, 500);
      if (!question) return json({ error: 'Missing "question"' }, 400);

      const history = sanitizeHistory(body.history);
      const corpus = await loadCorpus(env);
      const jurisdictions = Array.isArray(body.jurisdictions) ? body.jurisdictions : [];

      try {
        const result = await answerQuestion(question, corpus, env, history, jurisdictions);
        return json(result);
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};