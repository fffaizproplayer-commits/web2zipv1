const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const chromium = require("@sparticuz/chromium");
const JSZip = require("jszip");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { URL } = require("url");
const path = require("path");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PROXY_API = "https://api.ikyyxd.my.id/v2l/proxy-free/ikyy-xsample";

app.use(express.json());
app.use(express.static("public"));

// ─── Proxy manager ───────────────────────────────────────────

let proxies = [];
let proxyIndex = 0;
let proxyReady = false;

async function fetchProxies() {
  if (proxyReady && proxies.length) return;
  try {
    const res = await axios.get(PROXY_API, { timeout: 10000 });
    if (Array.isArray(res.data)) {
      proxies = res.data.filter(p => typeof p === "string" && p.split(":").length === 4);
      proxyReady = true;
      console.log(`Loaded ${proxies.length} proxies`);
    }
  } catch (e) {
    console.error("Failed to fetch proxies:", e.message);
  }
}

function rotateProxy() {
  if (proxies.length) proxyIndex = (proxyIndex + 1) % proxies.length;
}

function currentProxyUrl() {
  if (!proxies.length) return null;
  const p = proxies[proxyIndex];
  const parts = p.split(":");
  if (parts.length !== 4) return null;
  return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
}

// ─── Helpers ─────────────────────────────────────────────────

function sanitizePath(urlStr) {
  try {
    const u = new URL(urlStr);
    let p = u.pathname + u.search;
    p = p.replace(/^\//, "").replace(/[?#]/g, "_").replace(/[<>:"/\\|*]/g, "_");
    if (!p || p.endsWith("/")) p += "index.html";
    if (!path.extname(p)) p += ".html";
    return p || "index.html";
  } catch {
    return "file_" + Date.now();
  }
}

function isSameDomain(base, target) {
  try { return new URL(target).hostname === new URL(base).hostname; }
  catch { return false; }
}

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; }
  catch { return null; }
}

async function downloadAsset(url, proxyUrl) {
  try {
    const cfg = {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: { "User-Agent": UA, "Referer": new URL(url).origin },
      maxRedirects: 5,
    };
    if (proxyUrl) cfg.httpsAgent = new HttpsProxyAgent(proxyUrl);
    const res = await axios.get(url, cfg);
    return Buffer.from(res.data);
  } catch { return null; }
}

// ─── Main scrape ─────────────────────────────────────────────

async function scrapeWebsite(targetUrl, onProgress) {
  await fetchProxies();

  const executablePath = await chromium.executablePath();
  const proxyUrl = currentProxyUrl();

  const launchArgs = [
    ...chromium.args,
    "--disable-blink-features=AutomationControlled",
    "--window-size=1366,768",
  ];
  if (proxyUrl) launchArgs.push(`--proxy-server=${new URL(proxyUrl).host}`);

  const browser = await puppeteer.launch({
    args: launchArgs,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  const zip = new JSZip();
  const visited = new Set();
  const queue = [targetUrl];
  let processed = 0;
  let total = 1;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    // Inject proxy auth kalau ada
    if (proxyUrl) {
      const pu = new URL(proxyUrl);
      if (pu.username) {
        await page.authenticate({ username: pu.username, password: pu.password });
      }
    }

    const collectAssets = new Set();

    await page.setRequestInterception(true);
    page.on("request", req => req.continue());
    page.on("response", async res => {
      const url = res.url();
      if (isSameDomain(targetUrl, url) && !visited.has(url)) {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("text/html")) collectAssets.add(url);
      }
    });

    // ── Crawl pages ──
    while (queue.length > 0) {
      const currentUrl = queue.shift();
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      try {
        onProgress?.({ type: "page", url: currentUrl, processed: ++processed, total });

        await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise(r => setTimeout(r, 1000));

        // Cek apakah kena challenge Cloudflare
        const title = await page.title();
        const isChallenge = /just a moment|checking your browser|cloudflare|403|access denied/i.test(title);
        if (isChallenge) {
          onProgress?.({ type: "warn", url: currentUrl, msg: "CF challenge detected, rotating proxy..." });
          rotateProxy();
          // Coba ulang halaman ini
          queue.unshift(currentUrl);
          visited.delete(currentUrl);
          processed--;
          total--;
          continue;
        }

        const html = await page.content();
        zip.file(sanitizePath(currentUrl), html);

        // Kumpulin links
        const links = await page.evaluate(() =>
          [...document.querySelectorAll("a[href]")].map(a => a.href)
        );
        for (const link of links) {
          const resolved = resolveUrl(currentUrl, link);
          if (resolved && isSameDomain(targetUrl, resolved) && !visited.has(resolved) && !queue.includes(resolved)) {
            queue.push(resolved);
            total++;
          }
        }

        // Kumpulin assets dari DOM
        const domAssets = await page.evaluate(() => {
          const a = [];
          document.querySelectorAll("link[href]").forEach(el => a.push(el.href));
          document.querySelectorAll("script[src]").forEach(el => a.push(el.src));
          document.querySelectorAll("img[src], img[data-src]").forEach(el => a.push(el.src || el.dataset.src));
          document.querySelectorAll("source[src]").forEach(el => a.push(el.src));
          return a.filter(Boolean);
        });
        for (const a of domAssets) {
          const resolved = resolveUrl(currentUrl, a);
          if (resolved && isSameDomain(targetUrl, resolved)) collectAssets.add(resolved);
        }

      } catch (err) {
        console.error("Error crawling:", currentUrl, err.message);
      }
    }

    // ── Download assets ──
    const assetList = [...collectAssets].filter(u => !visited.has(u));
    total += assetList.length;

    for (const assetUrl of assetList) {
      if (visited.has(assetUrl)) continue;
      visited.add(assetUrl);
      onProgress?.({ type: "asset", url: assetUrl, processed: ++processed, total });

      const data = await downloadAsset(assetUrl, currentProxyUrl());
      if (data) zip.file(sanitizePath(assetUrl), data);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return zipBuffer;
  } finally {
    await browser.close();
  }
}

// ─── Routes ──────────────────────────────────────────────────

app.get("/api/scrape", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  let targetUrl;
  try {
    targetUrl = new URL(url.startsWith("http") ? url : "https://" + url).href;
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: "start", message: "Browser started (stealth mode)..." });
    const zipBuffer = await scrapeWebsite(targetUrl, (progress) => send(progress));
    const b64 = zipBuffer.toString("base64");
    send({ type: "done", zip: b64, size: zipBuffer.length });
  } catch (err) {
    send({ type: "error", message: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => console.log(`Web-to-ZIP running on port ${PORT}`));
