/**
 * Kleinanzeigen MacBook Deal Hunter - Asynchronous Image OCR Inspector
 * Zero-cost, 100% free local image intelligence powered by Tesseract.js.
 *
 * Rules:
 * 1. NEVER blocks or delays the initial Telegram dispatch.
 * 2. ONLY inspects images when battery health or crucial specs are unknown from text.
 * 3. Stops scanning as soon as battery health is confirmed.
 * 4. Extracts battery health %, chip, RAM, SSD from macOS screenshots ("Batteriezustand" & "Über diesen Mac").
 */

const Tesseract = require("tesseract.js");

let warmWorker = null;
let isInitializing = false;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Referer": "https://www.kleinanzeigen.de/"
};

async function getOcrWorker() {
  if (warmWorker) return warmWorker;
  if (isInitializing) {
    while (isInitializing) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (warmWorker) return warmWorker;
  }
  isInitializing = true;
  try {
    warmWorker = await Tesseract.createWorker("eng");
  } finally {
    isInitializing = false;
  }
  return warmWorker;
}

async function downloadImageBuffer(url, timeoutMs = 6000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Normalize image rule for highest resolution JPG
    let fetchUrl = url;
    if (fetchUrl.includes("rule=$_") || fetchUrl.includes("?rule=")) {
      fetchUrl = fetchUrl.replace(/\?rule=[^&]+/, "?rule=$_59.JPG");
    } else if (!fetchUrl.includes("?")) {
      fetchUrl += "?rule=$_59.JPG";
    }

    const resp = await fetch(fetchUrl, {
      headers: BROWSER_HEADERS,
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) return null;
    const arrayBuf = await resp.arrayBuffer();
    if (arrayBuf.byteLength < 5000) return null; // Skip corrupted/tiny images
    return Buffer.from(arrayBuf);
  } catch (e) {
    return null;
  }
}

function parseBatteryFromOcrText(rawText) {
  if (!rawText) return null;
  const text = rawText
    .replace(/<[^>]*>/g, " ")
    .replace(/[\*_~`#\\|]/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .toLowerCase();

  // Pattern 1: Explicit macOS battery phrases: "maximale kapazität 94%", "maximum capacity: 92%"
  const p1 = /(?:maximale\s+kapazität|maximum\s+capacity|restkapazität|kapazität|capacity|akkuzustand|batteriezustand|battery\s*health)[^0-9%\n]{0,35}(\d{2,3})\s*%/i;
  const m1 = text.match(p1);
  if (m1) {
    const v = parseInt(m1[1], 10);
    if (v >= 40 && v <= 100) return v;
  }

  // Pattern 2: Percentage followed by battery keyword
  const p2 = /(\d{2,3})\s*%\s*(?:akku|batterie|kapazität|capacity|health)/i;
  const m2 = text.match(p2);
  if (m2) {
    const v = parseInt(m2[1], 10);
    if (v >= 40 && v <= 100) return v;
  }

  // Pattern 3: If text clearly shows battery settings screen ("batteriezustand" or "maximum capacity")
  if (
    text.includes("maximale kapazität") ||
    text.includes("maximum capacity") ||
    text.includes("batteriezustand") ||
    text.includes("akkuzustand") ||
    (text.includes("batterie") && text.includes("zustand"))
  ) {
    const anyPercent = text.match(/\b([5-9][0-9]|100)\s*%/);
    if (anyPercent) {
      return parseInt(anyPercent[1], 10);
    }
  }

  return null;
}

function parseSpecsFromOcrText(rawText) {
  if (!rawText) return {};
  const text = rawText.toLowerCase();
  const specs = {};

  // Chip
  const chipM = text.match(/\bapple\s*m([1-5])\b/i) || text.match(/\bm([1-5])\s*chip\b/i);
  if (chipM) {
    specs.chipGeneration = `m${chipM[1]}`;
    if (text.includes("pro") || text.includes("max")) {
      specs.isMProOrMax = true;
    }
  }

  // RAM
  const ramM = text.match(/\b(8|16|18|24|32|36|48|64)\s*gb\b/i);
  if (ramM) {
    specs.ram = parseInt(ramM[1], 10);
  }

  // SSD
  const ssdM = text.match(/\b(256|512)\s*gb\b/i) || text.match(/\b(1|2)\s*tb\b/i);
  if (ssdM) {
    if (ssdM[0].includes("tb")) {
      specs.ssd = parseInt(ssdM[1], 10) * 1000;
    } else {
      specs.ssd = parseInt(ssdM[1], 10);
    }
  }

  return specs;
}

/**
 * Scan an array of image URLs asynchronously to find battery health or missing specs
 */
async function inspectListingImages(imageUrls, maxImages = 6) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { batteryHealth: null, specs: {}, inspectedCount: 0 };
  }

  const targetUrls = imageUrls.slice(0, maxImages);
  let detectedBattery = null;
  let detectedSpecs = {};
  let inspectedCount = 0;

  try {
    const worker = await getOcrWorker();

    for (const url of targetUrls) {
      inspectedCount++;
      const buf = await downloadImageBuffer(url);
      if (!buf) continue;

      const ret = await worker.recognize(buf);
      const text = ret.data?.text || "";

      // Check battery
      const bat = parseBatteryFromOcrText(text);
      if (bat !== null) {
        detectedBattery = bat;
      }

      // Check specs
      const sp = parseSpecsFromOcrText(text);
      detectedSpecs = { ...detectedSpecs, ...sp };

      // If battery is confirmed, stop scanning immediately!
      if (detectedBattery !== null) {
        break;
      }
    }
  } catch (err) {
    console.error("[ImageOCR] Error inspecting images:", err.message);
  }

  return {
    batteryHealth: detectedBattery,
    specs: detectedSpecs,
    inspectedCount
  };
}

module.exports = {
  getOcrWorker,
  downloadImageBuffer,
  parseBatteryFromOcrText,
  parseSpecsFromOcrText,
  inspectListingImages
};
