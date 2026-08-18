# Pharmacy Law Assistant: Grounded RAG Architecture for Regulatory Information Synthesis

[![Live Demo](https://img.shields.io/badge/Live_Demo-GitHub_Pages-2EA44F?style=for-the-badge)](https://yinaxu.github.io/Pharm-Law-Assistant/)

## Overview
Navigating pharmacy regulations, board rules, and state/federal controlled substance statutes requires absolute precision. Large Language Models (LLMs) often hallucinate or blend state-specific regulatory nuances, making ungrounded AI unsafe for legal or clinical reference.

The **Pharmacy Law Assistant** is an educational, retrieval-augmented generation (RAG) system designed to test and demonstrate **strict context-grounded retrieval**. The system enforces zero-hallucination boundaries by ensuring the LLM answers queries *exclusively* from an ingested knowledge base of primary statutory texts, citing exact sources for every statement.

---

## Core Technical & Analytical Highlights

* **Strict Source Grounding:** Designed to mitigate LLM hallucinations in high-stakes domain topics. The model is constrained to answer *only* using retrieved statutory excerpts.
* **Deterministic Source Attribution:** Answers are accompanied by precise inline citations, enabling immediate verification against primary regulatory texts.
* **Dynamic Knowledge Ingestion Pipeline:** Custom ingestion workflow capable of parsing, cleaning, and chunking heterogenous source material (PDF statutes, state board web pages, text files).
* **Privacy & Access Control:** Admin-authenticated pipeline for controlled corpus management, ensuring data integrity across ingested regulatory sources.

---

## System Architecture

The project consists of a lightweight frontend interface coupled with a serverless edge processing layer to handle retrieval, context construction, and generative grounding.

```
┌─────────────────────────────────┐
│       User Query Interface      │
│     (GitHub Pages Frontend)     │
└────────────────┘────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     Cloudflare Worker (Edge)    │
│  - Query Pre-processing         │
│  - Keyword & Citation Retrieval │
│  - Context Window Assembly      │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│      Context-Grounded LLM       │
│  (Strict Zero-Memory Prompting) │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Cited Output with Primary Links │
└─────────────────────────────────┘
```

### 1. Regulatory Corpus Ingestion & Text Processing
* **Document Parsing:** Browser-side and edge-side text extraction using `HTMLRewriter` and `PDF.js` to strip layout noise, scripts, and navigation artifacts, isolating clean legal prose.
* **Semantic Chunking:** Text is broken down into structured, overlapping ~900-character segments to preserve regulatory context across sentence boundaries.
* **Key-Value Indexing:** Text chunks are tagged with specific metadata (source URLs, citation identifiers, upload timestamps) and stored in Cloudflare KV.

### 2. Retrieval & Context Assembly
* **Targeted Scoring:** Incoming user queries are processed against the KV corpus to evaluate keyword overlap and structural relevancy.
* **Strict Context Windowing:** Only the top-scoring statutory excerpts are loaded into the prompt context window.
* **Strict Prompt Engineering:** The LLM is explicitly instructed to act as a pure synthesizer of the provided excerpts. If the answer is not present in the ingested excerpts, the system declines to answer rather than drawing from training memory.

---

## Project Structure

```text
├── index.html / script.js   # Public interface for query execution and citation display
├── admin.html               # Secure administrative panel for document ingestion
├── worker/
│   └── worker.js            # Edge worker handling retrieval, Gemini API execution, and ingestion
└── DEPLOY.md                # Deployment and environment setup documentation
```

---

## Future Enhancements & Clinical Applications

* **Vector Search Integration:** Upgrading keyword search scoring to dense vector embeddings (cosine similarity) for improved semantic matching of complex legal phrasing.
* **Multi-State Regulatory Comparison:** Expanding the schema to tag and filter statutes by jurisdiction (e.g., Federal vs. State Board of Pharmacy differences).
* **Automated Cron Ingestion:** Implementing scheduled scraping triggers to detect and ingest regulatory updates or board newsletters automatically.

---

## Disclaimer
*This project is an educational simulation and portfolio demonstration of Retrieval-Augmented Generation (RAG) principles applied to domain-specific information synthesis. It does not constitute formal legal advice, clinical decision support, or official regulatory guidance.*
