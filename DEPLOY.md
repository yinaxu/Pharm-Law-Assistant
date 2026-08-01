# Deploying your Pharmacy Law Assistant — plain-language walkthrough

You do **not** need to understand or edit any JSON anywhere in this project.
The only file you'll hand-edit is `script.js`, and only one line, shown
exactly below.

Three things to deploy:
- **The backend** (the "brain" + its growing library of scraped/uploaded sources) → Cloudflare
- **The frontend** (the public website people see) → GitHub Pages
- **The admin panel** (where *you* add sources) → also GitHub Pages, but not linked anywhere public

---

## What you need before starting

- [ ] A computer (not phone) with the Terminal app (Mac) or Command Prompt/PowerShell (Windows)
- [ ] A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- [ ] A free [GitHub](https://github.com/join) account
- [ ] A Gemini API key (see Step 1)
- [ ] The `pharmlaw-portfolio.zip` file, unzipped somewhere easy to find (like your Desktop)

---

## Step 1 — Get a Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key**, then copy it somewhere safe.
3. Gemini has a free usage tier that's plenty for a portfolio demo. Check current limits at [ai.google.dev/pricing](https://ai.google.dev/pricing) since they can change.

---

## Step 2 — Install the tool that deploys the backend

Open **Terminal** (Mac) or **PowerShell** (Windows).

Check for Node.js:
```
node -v
```
- See a version number? Skip ahead.
- See "command not found"? Install it from [nodejs.org](https://nodejs.org) (the "LTS" version), then reopen Terminal.

Install Wrangler, the tool that manages your Cloudflare backend:
```
npm install -g wrangler
```
Check it worked:
```
wrangler -v
```

---

## Step 3 — Go into the worker folder

```
cd Desktop/pharmlaw-portfolio/worker
```
(Adjust to wherever you unzipped it. Tip: type `cd ` with a trailing space, then drag the `worker` folder into the Terminal window to auto-fill the path.)

---

## Step 4 — Log in to Cloudflare

```
wrangler login
```
This opens your browser — log in (or sign up), click **Allow**, then return to Terminal.

---

## Step 5 — Create the storage for your scraped/uploaded sources

This project stores everything you scrape or upload in a small Cloudflare
database called KV. Create it once:
```
wrangler kv namespace create CORPUS_KV
```
It prints something like:
```
[[kv_namespaces]]
binding = "CORPUS_KV"
id = "a1b2c3d4e5f6..."
```
Open `wrangler.toml` (in the same `worker` folder) in a text editor, find this line near the bottom:
```
id = "REPLACE_WITH_YOUR_KV_ID"
```
and replace `REPLACE_WITH_YOUR_KV_ID` with the `id` value Wrangler printed. Save the file.

---

## Step 6 — Set your two secret keys

```
wrangler secret put GEMINI_API_KEY
```
Paste the key from Step 1 when prompted.

```
wrangler secret put ADMIN_KEY
```
Make up your own password here — anything you'll remember. This is what
protects your admin panel (Step 10) so random visitors can't make your
backend scrape websites on your behalf. Store it in your Notes app alongside
the Gemini key.

Neither secret ever appears in your code or on GitHub — Cloudflare holds them.

---

## Step 7 — Deploy the backend

```
wrangler deploy
```
Near the end you'll see:
```
Published pharmlaw-rag-api
  https://pharmlaw-rag-api.yourname.workers.dev
```
**Copy that URL.**

### Quick test (optional)
```
curl -X POST https://pharmlaw-rag-api.yourname.workers.dev -H "Content-Type: application/json" -d "{\"question\":\"Can a pharmacist refill a Schedule II prescription?\"}"
```
A paragraph mentioning "Schedule II" back means it's working.

---

## Step 8 — Connect the public website to the backend

1. Open `script.js` (in the main `pharmlaw-portfolio` folder, not `worker`) in any text editor.
2. Find:
   ```
   const WORKER_URL = "https://pharmlaw-rag-api.YOUR-SUBDOMAIN.workers.dev";
   ```
3. Replace the URL with the one from Step 7.
4. Save.

---

## Step 9 — Put the website on GitHub Pages

**No Terminal needed:**

1. On [github.com](https://github.com), click **+** → **New repository**. Name it anything, keep it **Public**, click **Create repository**.
2. Click **uploading an existing file**.
3. Drag in: `index.html`, `styles.css`, `script.js` (the edited one), `README.md`, and `admin.html`.
   *(Don't upload the `worker` folder — it already lives on Cloudflare.)*
4. Click **Commit changes**.
5. Go to **Settings → Pages**. Under **Branch**, choose `main` / `(root)`, click **Save**.
6. Wait 1–2 minutes — your site is live at:
   ```
   https://yourusername.github.io/pharmlaw-portfolio/
   ```

---

## Step 10 — Add sources with the admin panel

Go to `https://yourusername.github.io/pharmlaw-portfolio/admin.html`
(it's a real page, just not linked from the site's menu — bookmark it).

1. Paste your **Worker URL** (from Step 7) and your **Admin key** (from Step 6) into the two fields at the top. These stay in the browser tab only — you'll re-enter them next visit.
2. **To scrape a web page**: paste its URL into "Add a source by URL" and click **Scrape & add**. The backend fetches the page, strips out navigation/ads/scripts, and stores the actual text.
3. **To upload a file**: choose a `.txt`, `.md`, `.html`, or `.pdf` file. The text is extracted right there in your browser (you'll see a preview you can edit before saving — handy for trimming boilerplate), then click **Add to corpus**.
4. Scroll down to **Currently indexed** and click **Refresh list** to confirm it's there.

Every question asked on the public site now searches everything you've added here — no redeploying required.

---

## Step 11 — Test the live site

Open your public site, scroll to the chat box, and ask about something you
just added (or one of the sample questions). You should get a grounded
answer with clickable citation chips.

---

## If something doesn't work

- **"Unauthorized" in the admin panel** → the Admin key field doesn't match what you set in Step 6. Re-run `wrangler secret put ADMIN_KEY` if you forgot it (this lets you set a new one).
- **"Server misconfigured: GEMINI_API_KEY..."** → redo Step 6's first command.
- **Scraping a URL fails** → some sites block automated requests, or the page is mostly JavaScript-rendered (no real text in the raw HTML). Try a different, simpler page from the same source, or use the file upload instead (save the page as PDF and upload that).
- **Chat says "This demo isn't wired up to a live backend yet"** → recheck Step 8's URL.
- **GitHub Pages shows a blank/404 page** → confirm `index.html` is at the repo's *root*, not in a subfolder.

---

You never had to open, edit, or understand any JSON file in this project —
the corpus lives entirely in Cloudflare's storage once you're set up.
