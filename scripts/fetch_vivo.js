#!/usr/bin/env node
const fs = require("fs");
const { chromium } = require("playwright");

const output = process.argv[2] || "/tmp/vivo-source.json";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ locale: "pt-BR" });
  let settled = false;
  let resolvePayload;
  const payload = new Promise((resolve) => { resolvePayload = resolve; });

  page.on("response", async (response) => {
    if (settled || !response.url().includes("/instance/25/service/channels?")) return;
    try {
      const body = await response.text();
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.channels) || parsed.channels.length < 20) return;
      settled = true;
      fs.writeFileSync(output, JSON.stringify(parsed));
      resolvePayload(parsed.channels.length);
    } catch (_) {
      // The page may issue the request more than once. Keep waiting for a valid response.
    }
  });

  await page.goto("https://www.vivotv.com.br/tv-guide/now", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Vivo EPG request was not captured")), 60000);
  });
  const count = await Promise.race([payload, timeout]);
  console.log(`ok Vivo: ${count} canais`);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
