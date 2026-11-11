#!/usr/bin/env node
const fs = require("fs");
const { chromium } = require("playwright");

const output = process.argv[2] || "/tmp/vivo-source.json";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ locale: "pt-BR" });
  let settled = false;
  let channelsUrl = "";
  let resolvePayload;
  const payload = new Promise((resolve) => { resolvePayload = resolve; });

  page.on("response", async (response) => {
    if (settled || !response.url().includes("/instance/25/service/channels?")) return;
    try {
      const body = await response.text();
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.channels) || parsed.channels.length < 20) return;
      settled = true;
      channelsUrl = response.url();
      resolvePayload(parsed);
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
  const initial = await Promise.race([payload, timeout]);
  const candidates = [initial];

  // The Vivo CDN occasionally serves GitHub runners a reduced channel map that
  // omits Globo SP (HDGLO), even though channelMap=3 is requested. Retry from
  // the authenticated page context with a unique URL to bypass that CDN entry.
  for (let attempt = 0; attempt < 3 && !hasChannel(candidates, "HDGLO"); attempt += 1) {
    try {
      const separator = channelsUrl.includes("?") ? "&" : "?";
      const retryUrl = `${channelsUrl}${separator}_apsky=${Date.now()}-${attempt}`;
      const retried = await page.evaluate(async (url) => {
        const response = await fetch(url, { cache: "no-store", credentials: "include" });
        if (!response.ok) throw new Error(`Vivo retry returned ${response.status}`);
        return response.json();
      }, retryUrl);
      if (Array.isArray(retried.channels) && retried.channels.length >= 20) {
        candidates.push(retried);
      }
    } catch (error) {
      console.warn(`Vivo retry ${attempt + 1} failed: ${error.message}`);
    }
  }

  const selected = candidates.sort((a, b) => score(b) - score(a))[0];
  fs.writeFileSync(output, JSON.stringify(selected));
  const globo = selected.channels.some((channel) => channel.callLetter === "HDGLO");
  console.log(`ok Vivo: ${selected.channels.length} canais; HDGLO: ${globo ? "sim" : "nao"}`);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function hasChannel(payloads, callLetter) {
  return payloads.some((payload) =>
    payload.channels.some((channel) => channel.callLetter === callLetter));
}

function score(payload) {
  const hasGloboSp = payload.channels.some((channel) => channel.callLetter === "HDGLO");
  return payload.channels.length + (hasGloboSp ? 10000 : 0);
}
