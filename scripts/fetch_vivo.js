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

  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Vivo EPG request was not captured")), 60000);
  });
  const initial = await Promise.race([payload, timeout]);
  clearTimeout(timeoutHandle);
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
  const globoSchedule = await fetchGloboSchedule();
  if (globoSchedule.length) {
    const globoChannel = {
      pid: "LCH57",
      callLetter: "HDGLO",
      channelNumber: 502,
      title: "Globo SP",
      contents: globoSchedule,
    };
    const index = selected.channels.findIndex((channel) => channel.callLetter === "HDGLO");
    if (index >= 0) selected.channels[index] = globoChannel;
    else selected.channels.push(globoChannel);
  }
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

async function fetchGloboSchedule() {
  const endpoint = "https://contentapi-br.cdn.telefonica.com/25/default/pt-BR/schedules";
  const now = Math.floor(Date.now() / 1000);
  const firstWindow = now - (6 * 60 * 60);
  const programs = new Map();

  for (let day = 0; day < 7; day += 1) {
    const start = firstWindow + (day * 24 * 60 * 60);
    const params = new URLSearchParams({
      ca_deviceTypes: "null|401",
      ca_channelmaps: "3|null",
      fields: "Pid,Title,Description,ChannelName,ChannelNumber,CallLetter,Start,End,LiveChannelPid,LiveProgramPid,SeriesId,SeasonNumber,images.videoFrame,images.banner,AgeRatingPid",
      orderBy: "START_TIME:a",
      filteravailability: "false",
      starttime: String(start),
      endtime: String(start + (24 * 60 * 60)),
      livechannelpids: "lch57",
      offset: "0",
      limit: "1000",
    });
    try {
      const response = await fetch(`${endpoint}?${params}`, {
        headers: { "User-Agent": "Mozilla/5.0 APSKY-EPG" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      for (const item of data.Content || []) {
        const frames = (item.Images || {}).VideoFrame || [];
        programs.set(`${item.Start}:${item.Pid}`, {
          title: item.Title || "",
          description: item.Description || "",
          shortDescription: item.Description || "",
          emissionDate: { start: item.Start, end: item.End },
          image: { url: (frames[0] || {}).Url || "" },
          liveChannel: { pid: "LCH57", title: "Globo SP", callLetter: "HDGLO" },
          ageRating: { code: "" },
          genres: [],
        });
      }
    } catch (error) {
      console.warn(`Vivo HDGLO day ${day + 1} failed: ${error.message}`);
    }
  }
  const result = [...programs.values()].sort(
    (left, right) => left.emissionDate.start - right.emissionDate.start);
  console.log(`Vivo HDGLO semanal: ${result.length} programas, ${result.filter((item) => item.image.url).length} imagens`);
  return result;
}
