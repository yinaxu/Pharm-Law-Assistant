# Pharmacy Law Assistant — portfolio site + RAG chatbot

A GitHub Pages portfolio showcasing a retrieval-augmented pharmacy law
chatbot. It answers questions grounded in a knowledge base you build by
**scraping web pages** or **uploading files** — never from the model's own
memory — and every answer cites back to its source.

**Full setup walkthrough: see [`DEPLOY.md`](DEPLOY.md).** This file just
covers the architecture.

## The three pieces

| Piece | What it does | Where it lives |
|---|---|---|
| `index.html` / `styles.css` / `script.js` | Public portfolio page + chat demo | GitHub Pages |
| `admin.html` | Owner-only tool: scrape a URL or upload a file into the corpus | GitHub Pages (unlinked, protected by an admin key) |
| `worker/worker.js` | Retrieval + calls Gemini to answer; also handles scraping/ingestion | Cloudflare Workers |

GitHub Pages can't run a server or hold secrets, so the actual thinking and
storage live in the Worker. The two frontend pages just talk to it over
`fetch()`.

## How a source gets in

1. You open `admin.html`, paste a URL (or upload a `.txt`/`.md`/`.html`/`.pdf`).
2. **For a URL**: the Worker fetches the page and strips it down to plain
   text using Cloudflare's built-in `HTMLRewriter` (removes nav/scripts/ads).
3. **For a file**: the same extraction happens in your browser instead —
   plain text and Markdown are read directly, HTML is parsed and stripped
   with the browser's own parser, and PDFs are read page-by-page with
   PDF.js. You see the extracted text and can edit it before saving.
4. Either way, the text gets split into ~900-character overlapping chunks
   and stored in Cloudflare KV (a small key-value database), tagged with a
   citation and the original URL (if any).

## How a question gets answered

1. The question is tokenized and scored against every stored chunk
   (keyword overlap + citation-number matching).
2. The top 4 matches — and only those — are placed in Gemini's context with
   an instruction to answer strictly from them and cite which excerpt
   supports each claim.
3. The frontend renders the answer with clickable citation chips.

No scraping happens at question-answering time — sources are added ahead of
time through the admin panel, so answering stays fast and doesn't depend on
a target website being reachable at that exact moment.

## Security note

The `/ingest/url` and `/ingest/text` endpoints require an `ADMIN_KEY`
header. Without that, anyone who found your Worker URL could make it fetch
arbitrary sites on your Cloudflare bill. Keep the admin key private and
don't commit it anywhere — `DEPLOY.md` walks through setting it as a
Cloudflare secret, never as code.

## Extending it

- **Swap keyword search for real embeddings**: replace `retrieve()` in
  `worker.js` with an embeddings API call + cosine similarity — everything
  else stays the same.
- **Add state pharmacy law**: scrape/upload it like anything else, just
  label the citation clearly per-state since it varies widely.
- **Scheduled re-scraping**: Cloudflare Workers support Cron Triggers if you
  want previously-added URLs re-scraped periodically to catch regulation
  changes — not included here, but a natural next step.

## Disclaimer

Educational demo only — not legal advice. Accuracy depends entirely on
what's been scraped or uploaded; verify anything consequential against the
primary source.
