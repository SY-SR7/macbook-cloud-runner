/**
 * 24/7 Autonomous Cloud Hunter - Kleinanzeigen MacBook Multi-Bot
 * Runs perpetually on GitHub Actions runners with automatic daisy-chaining and Gist state persistence.
 * Operates 24/7 completely independently of any local machine or laptop.
 */

const fs = require("fs");
const path = require("path");

const { RulesEngine } = require("./src/rules-engine.js");
const { MessageGenerator } = require("./src/message-generator.js");
const { inspectListingImages } = require("./src/image-ocr-helper.js");

const GITHUB_TOKEN = (process.env.GIST_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const GITHUB_GIST_ID = (process.env.GIST_ID || process.env.GITHUB_GIST_ID || "b990aa1d340a72ea10c45fcfa49937fd").trim();
const GITHUB_REPOSITORY = (process.env.GITHUB_REPOSITORY || "SY-SR7/macbook-cloud-runner").trim();
const SHIFT_MINUTES = Math.max(10, parseInt(process.env.SHIFT_MINUTES || "25", 10) || 25);
const BASE_SCAN_SECONDS = Math.max(45, parseInt(process.env.SCAN_INTERVAL_SECONDS || "55", 10) || 55);

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    console.error(`[Storage] Error reading ${filePath}:`, e.message);
  }
  return fallback;
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error(`[Storage] Error writing ${filePath}:`, e.message);
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cleanText(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0"
];

function getHeaders() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache"
  };
}

function parseArticlesFromSearchHtml(html) {
  const results = [];
  const articleRegex = /<article\b[^>]*data-adid="(\d+)"[\s\S]*?<\/article>/gi;
  let m;

  while ((m = articleRegex.exec(html)) !== null) {
    const adId = m[1];
    const articleHtml = m[0];

    // Extract Title robustly (ld+json -> <h3><a> -> legacy <a>)
    let rawTitle = "";
    const ldJsonMatch = articleHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (ldJsonMatch) {
      try {
        const ld = JSON.parse(ldJsonMatch[1]);
        if (ld.title) rawTitle = cleanText(ld.title);
      } catch (e) {}
    }

    if (!rawTitle) {
      const h3Match = articleHtml.match(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i);
      if (h3Match) rawTitle = cleanText(h3Match[1]);
    }

    if (!rawTitle) {
      const titleMatch = articleHtml.match(/<a\b[^>]*class="[^"]*ellipsis[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (titleMatch) rawTitle = cleanText(titleMatch[2]);
    }

    // Extract URL robustly (data-href -> /s-anzeige/)
    let adUrl = "";
    const dataHrefMatch = articleHtml.match(/data-href="([^"]+)"/i);
    if (dataHrefMatch) {
      adUrl = dataHrefMatch[1].startsWith("http") ? dataHrefMatch[1] : `https://www.kleinanzeigen.de${dataHrefMatch[1]}`;
    } else {
      const hrefMatch = articleHtml.match(/href="(\/s-anzeige\/[^"]+)"/i);
      if (hrefMatch) adUrl = hrefMatch[1].startsWith("http") ? hrefMatch[1] : `https://www.kleinanzeigen.de${hrefMatch[1]}`;
    }

    // Robust multi-tier price parser for modern & legacy Kleinanzeigen HTML
    let priceText = "";

    // 1. Modern classes (text-title3, font-strong, text-secondary)
    const modernPriceMatch = articleHtml.match(/<p\b[^>]*class="[^"]*(?:text-title|font-strong|price-shipping)[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (modernPriceMatch && (modernPriceMatch[1].includes("€") || modernPriceMatch[1].includes("VB"))) {
      priceText = cleanText(modernPriceMatch[1]);
    }

    // 2. Direct HTML tag containing euro symbol and digits
    if (!priceText) {
      const euroTagMatch = articleHtml.match(/<[a-z0-9]+\b[^>]*>([^<]*\d[\d\.,\s]*€[^<]*)<\/[a-z0-9]+>/i);
      if (euroTagMatch) {
        priceText = cleanText(euroTagMatch[1]);
      }
    }

    // 3. Legacy price-shipping class
    if (!priceText) {
      const legacyMatch = articleHtml.match(/<p\b[^>]*class="[^"]*aditem-main--middle--price-shipping--price[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
        articleHtml.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\//i);
      if (legacyMatch) priceText = cleanText(legacyMatch[1]);
    }

    // 4. Any explicit Euro pattern within the article
    if (!priceText) {
      const anyEuro = articleHtml.match(/(\d{2,5}(?:[\.,]\d{2})?\s*€(?:\s*VB)?)/i);
      if (anyEuro) priceText = anyEuro[1].trim();
    }

    const locMatch = articleHtml.match(/<div\b[^>]*class="[^"]*aditem-main--top--left[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      articleHtml.match(/<span\b[^>]*class="[^"]*(?:location|city)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const locationText = locMatch ? cleanText(locMatch[1]) : "";

    const descMatch = articleHtml.match(/<p\b[^>]*class="[^"]*aditem-main--middle--description[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      articleHtml.match(/<p\b[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const snippetDesc = descMatch ? cleanText(descMatch[1]) : "";

    if (adId && rawTitle) {
      results.push({
        adId,
        title: rawTitle,
        adUrl,
        priceText,
        locationText,
        snippetDesc
      });
    }
  }

  return results;
}

async function fetchFullDetails(adUrl) {
  if (!adUrl) return { description: "", images: [], price: null };
  try {
    const resp = await fetch(adUrl, { headers: getHeaders() });
    if (!resp.ok) return { description: "", images: [], price: null };
    const html = await resp.text();
    const descMatch = html.match(/id="viewad-description-text"[^>]*>([\s\S]*?)<\/p>/i) ||
      html.match(/class="[^"]*viewad-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch ? cleanText(descMatch[1]) : "";

    const imgMatches = html.match(/https:\/\/img\.kleinanzeigen\.de\/api\/v1\/prod-ads\/images\/[a-f0-9]{2}\/[a-f0-9\-]+/gi) || [];
    const uniqueBase = [...new Set(imgMatches)];
    const images = uniqueBase.map(u => `${u}?rule=$_59.JPG`);

    // Backup price from detail page if search snippet didn't have it
    let price = null;
    const priceDetailMatch = html.match(/id="viewad-price"[^>]*>([\s\S]*?)<\/span>/i) ||
      html.match(/class="[^"]*viewad-price[^"]*"[^>]*>([\s\S]*?)<\//i) ||
      html.match(/(\d{2,5})\s*€/);
    if (priceDetailMatch) {
      const numOnly = priceDetailMatch[1].replace(/[^0-9]/g, "");
      if (numOnly) price = parseInt(numOnly, 10);
    }

    return { description, images, price };
  } catch (e) {
    return { description: "", images: [], price: null };
  }
}

// ==========================================
// Bot Instance
// ==========================================

class BotHunterInstance {
  constructor(botConfig) {
    this.cfg = botConfig;
    this.id = botConfig.id;
    this.name = botConfig.name;
    this.token = botConfig.telegramBotToken;
    this.searchUrl = botConfig.searchUrl;
    this.rules = botConfig.rules || {};
    this.sendSuggestedMessage = Boolean(botConfig.sendSuggestedMessage);
    this.enableSaveDeals = Boolean(botConfig.enableSaveDeals);

    this.notifiedFile = path.join(DATA_DIR, `notified_ads_${this.id}.json`);
    this.subsFile = path.join(DATA_DIR, `subscribers_${this.id}.json`);
    this.savedFile = path.join(DATA_DIR, `saved_deals_${this.id}.json`);
    this.sentMsgsFile = path.join(DATA_DIR, `sent_messages_${this.id}.json`);

    this.notifiedAds = loadJson(this.notifiedFile, []);
    this.subscribers = loadJson(this.subsFile, []);
    this.savedDeals = loadJson(this.savedFile, []);
    this.sentMessages = loadJson(this.sentMsgsFile, { byMsgId: {}, byAdId: {} });

    if (botConfig.telegramChatId && !this.subscribers.includes(String(botConfig.telegramChatId))) {
      this.subscribers.push(String(botConfig.telegramChatId));
    }

    this.seenRejectedIds = new Set();
    this.isScanning = false;
    this.consecutiveErrors = 0;
    this.lastUpdateId = 0;
    this.pendingPriceByChat = {};
    this.msgGenerator = new MessageGenerator();

    this.lastScanStats = {
      time: null,
      found: 0,
      qualified: 0,
      sentNew: 0,
      error: null
    };
  }

  saveLocalState() {
    saveJson(this.notifiedFile, this.notifiedAds);
    saveJson(this.subsFile, this.subscribers);
    saveJson(this.savedFile, this.savedDeals);
    saveJson(this.sentMsgsFile, this.sentMessages);
  }

  async tgApi(method, payload = {}) {
    if (!this.token) return { ok: false, description: "NO_TOKEN" };
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return await res.json();
    } catch (err) {
      console.error(`[${this.id}] TG API ${method} error:`, err.message);
      return { ok: false, description: err.message };
    }
  }

  async sendHtml(chatId, htmlText, replyMarkup = null) {
    const payload = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    return this.tgApi("sendMessage", payload);
  }

  buildProposedMessage(parsed, evaluation) {
    if (evaluation.action === "TELEGRAM_ALERT_MPRO") {
      return this.msgGenerator.getBatteryInquiryMessage();
    }
    if (evaluation.action === "INQUIRE_MISSING_SPECS") {
      return this.msgGenerator.getMissingSpecsInquiryMessage(evaluation.missingSpecs || []);
    }
    if (evaluation.action === "INQUIRE_BATTERY") {
      return this.msgGenerator.getBatteryInquiryMessage();
    }
    if (evaluation.action === "SEND_OFFER") {
      return this.msgGenerator.getFirstOfferMessage(evaluation.initialOffer, parsed.isInHannover || parsed.isInTargetCity);
    }
    return "";
  }

  buildNotificationCard(item, evaluation) {
    const isMPro = evaluation?.action === "TELEGRAM_ALERT_MPRO";
    let cityLabel = "هانوفر وما حولها";
    if (this.rules.targetCity === "hamburg") cityLabel = "هامبورغ";
    if (this.rules.targetCity === "halle") cityLabel = "هالة زالة";

    const headerEmoji = isMPro
      ? `🔥 <b>لُقطة ماكبوك M Pro / M Max في ${cityLabel}!</b> 🔥`
      : `🍎 <b>عرض ماكبوك جديد في ${cityLabel}!</b>`;

    const specsParts = [];
    if (item.modelType) specsParts.push(item.modelType === "pro" ? "MacBook Pro" : "MacBook Air");
    if (item.chipGeneration) specsParts.push(item.chipGeneration.toUpperCase());
    if (item.ram) specsParts.push(`${item.ram}GB RAM`);
    if (item.ssd) specsParts.push(`${item.ssd >= 1000 ? "1TB" : item.ssd + "GB"} SSD`);
    const specsLine = specsParts.length > 0 ? specsParts.join(" | ") : "غير مكتملة";

    let batteryLine = "غير مذكورة في الإعلان";
    if (item.batteryHealth) {
      batteryLine = `<b>${item.batteryHealth}%</b>`;
    }

    let locLine = escapeHtml(item.locationStr || cityLabel);
    if (item.isInTargetCity || item.isInHannover) {
      locLine = `داخل ${cityLabel} 📍 (${escapeHtml(item.locationStr || cityLabel)})`;
    } else if (item.distanceKm) {
      locLine = `${escapeHtml(item.locationStr || cityLabel)} (${item.distanceKm} كم 🚗)`;
    }

    let targetPriceLine = "";
    if (isMPro) {
      targetPriceLine = `⚡ <b>الملاحظة:</b> فئة M Pro/Max بسعر استثنائي — راجع الإعلان فوراً!`;
    } else if (evaluation?.initialOffer) {
      const maxStr = evaluation.maxOffer && evaluation.maxOffer > evaluation.initialOffer
        ? ` (أقصى حد: ${evaluation.maxOffer}€)`
        : "";
      targetPriceLine = `🎯 <b>السعر المستهدف / العادل:</b> <b>${evaluation.initialOffer}€</b>${maxStr}`;
    }

    const cardText =
      `${headerEmoji}\n\n` +
      `💻 <b>العنوان:</b> ${escapeHtml(item.title || "MacBook")}\n` +
      `⚙️ <b>المواصفات:</b> ${escapeHtml(specsLine)}\n` +
      `💰 <b>السعر المعروض:</b> <b>${item.price || "?"}€</b>\n` +
      `${targetPriceLine ? targetPriceLine + "\n" : ""}` +
      `🔋 <b>البطارية:</b> ${batteryLine}\n` +
      `📍 <b>الموقع:</b> ${locLine}\n\n` +
      (this.enableSaveDeals
        ? `💡 <i>ضع لايك (👍) على هذه الرسالة أو اضغط "حفظ الصفقة" إذا اتفقت مع البائع لتسجيل السعر!</i>`
        : `💡 <i>اضغط على الزر بالأسفل لفتح الإعلان في تطبيق Kleinanzeigen:</i>`);

    const buttons = [
      [{ text: "🔗 فتح الإعلان في التطبيق", url: item.url || "https://www.kleinanzeigen.de" }]
    ];

    if (this.enableSaveDeals) {
      buttons.push([
        { text: "⭐ تم الاتفاق / حفظ الصفقة", callback_data: `save:${item.adId}` },
        { text: "❌ تجاهل", callback_data: `dismiss:${item.adId}` }
      ]);
    }

    return { text: cardText, keyboard: { inline_keyboard: buttons }, specsLine };
  }

  async dispatchDeal(itemData, evaluation, proposedMessage) {
    if (this.subscribers.length === 0) {
      console.log(`[${this.id}] No subscribers yet to dispatch ad ${itemData.adId}.`);
      return { success: false, reason: "NO_SUBSCRIBERS" };
    }

    const card = this.buildNotificationCard(itemData, evaluation);
    const adId = String(itemData.adId);
    let firstMsg1Id = null;
    let firstMsg2Id = null;

    for (const chatId of this.subscribers) {
      const res1 = await this.sendHtml(chatId, card.text, card.keyboard);
      if (res1.ok && res1.result?.message_id) {
        const msg1Id = res1.result.message_id;
        if (!firstMsg1Id) firstMsg1Id = msg1Id;

        const storedRecord = {
          adId,
          messageId: msg1Id,
          title: itemData.title || "MacBook",
          listedPrice: itemData.price || 0,
          targetOffer: evaluation?.initialOffer || null,
          url: itemData.url || "https://www.kleinanzeigen.de",
          specs: card.specsLine,
          location: itemData.locationStr || "",
          sentAt: Date.now()
        };

        this.sentMessages.byMsgId[String(msg1Id)] = storedRecord;
        this.sentMessages.byAdId[adId] = storedRecord;

        if (this.sendSuggestedMessage && proposedMessage && proposedMessage.trim().length > 0) {
          const msg2Text =
            `📋 <b>الرسالة المناسبة للبائع (اضغط على النص بالأسفل لنسخه فوراً):</b>\n\n` +
            `<code>${escapeHtml(proposedMessage.trim())}</code>`;
          const res2 = await this.sendHtml(chatId, msg2Text);
          if (res2.ok && res2.result?.message_id) {
            const msg2Id = res2.result.message_id;
            if (!firstMsg2Id) firstMsg2Id = msg2Id;
            this.sentMessages.byMsgId[String(msg2Id)] = storedRecord;
          }
        }
      }
      await sleep(150);
    }

    this.saveLocalState();
    scheduleGistSync();
    console.log(`[${this.id}] Dispatched deal [${adId}] (${itemData.title}) at ${itemData.price}€ to ${this.subscribers.length} subscriber(s).`);
    return { success: true, messageId: firstMsg1Id, msg2Id: firstMsg2Id };
  }

  async inspectAdImagesAndUpdateTelegramAsync(itemData, evaluation, msg1Id, msg2Id, images) {
    try {
      const ocrResult = await inspectListingImages(images, 5);
      if (!ocrResult || (ocrResult.batteryHealth === null && !ocrResult.specs?.ram && !ocrResult.specs?.ssd)) {
        return;
      }

      const detectedBattery = ocrResult.batteryHealth;

      if (detectedBattery !== null && detectedBattery < 90) {
        console.log(`[${this.id}:OCR] Ad ${itemData.adId}: Battery ${detectedBattery}% < 90%! Disqualifying.`);
        const disqualifiedText =
          `⚠️ <b>تنبيه فحص الصور الذكي (OCR):</b>\n` +
          `تم فحص صور الإعلان واكتشاف نسبة البطارية: <b>${detectedBattery}%</b> ❌\n` +
          `<i>(أقل من الحد الأدنى المطلوب 90% — تم استبعاد الجهاز تلقائياً)</i>\n\n` +
          `<s>💻 ${escapeHtml(itemData.title || "MacBook")}</s>\n` +
          `💰 السعر: ${itemData.price || "?"}€ | 📍 ${escapeHtml(itemData.locationStr || "")}\n\n` +
          `⛔ <b>الجهاز غير مؤهل.</b>`;

        for (const chatId of this.subscribers) {
          await this.tgApi("editMessageText", {
            chat_id: chatId,
            message_id: msg1Id,
            text: disqualifiedText,
            parse_mode: "HTML",
            disable_web_page_preview: true
          });

          if (this.sendSuggestedMessage && msg2Id) {
            await this.tgApi("editMessageText", {
              chat_id: chatId,
              message_id: msg2Id,
              text: `❌ <i>تم إلغاء الاقتراح لأن البطارية (${detectedBattery}%) أقل من 90% وفقاً للصور.</i>`,
              parse_mode: "HTML"
            });
          }
        }
        return;
      }

      let updatedItem = { ...itemData };
      if (detectedBattery !== null) updatedItem.batteryHealth = detectedBattery;
      if (!updatedItem.ram && ocrResult.specs?.ram) updatedItem.ram = ocrResult.specs.ram;
      if (!updatedItem.ssd && ocrResult.specs?.ssd) updatedItem.ssd = ocrResult.specs.ssd;

      const newEval = RulesEngine.evaluateDeal(updatedItem);
      if (!newEval || newEval.action === "IGNORE" || newEval.action === "SKIP") return;

      console.log(`[${this.id}:OCR] Ad ${itemData.adId}: Confirmed battery ${detectedBattery}% from images.`);
      const updatedCard = this.buildNotificationCard(updatedItem, newEval);

      for (const chatId of this.subscribers) {
        await this.tgApi("editMessageText", {
          chat_id: chatId,
          message_id: msg1Id,
          text: updatedCard.text,
          reply_markup: updatedCard.keyboard,
          parse_mode: "HTML",
          disable_web_page_preview: true
        });

        if (this.sendSuggestedMessage && msg2Id) {
          const newProposed = this.buildProposedMessage(updatedItem, newEval);
          if (newProposed) {
            const updatedMsg2 =
              `📋 <b>الرسالة المناسبة للبائع (تم تحديثها تلقائياً بعد فحص الصور):</b>\n\n` +
              `<code>${escapeHtml(newProposed.trim())}</code>`;
            await this.tgApi("editMessageText", {
              chat_id: chatId,
              message_id: msg2Id,
              text: updatedMsg2,
              parse_mode: "HTML"
            });
          }
        }
      }

      if (this.sentMessages.byAdId[String(updatedItem.adId)]) {
        this.sentMessages.byAdId[String(updatedItem.adId)].targetOffer = newEval.initialOffer || null;
        this.sentMessages.byAdId[String(updatedItem.adId)].specs = updatedCard.specsLine;
      }
      this.saveLocalState();
      scheduleGistSync();
    } catch (err) {
      console.error(`[${this.id}:OCR] Error:`, err.message);
    }
  }

  async completeSaveDeal(chatId, deal, agreedPrice) {
    delete this.pendingPriceByChat[String(chatId)];
    this.savedDeals = this.savedDeals.filter(d => String(d.adId) !== String(deal.adId));
    this.savedDeals.push({
      adId: deal.adId,
      title: deal.title,
      agreedPrice: Number(agreedPrice),
      listedPrice: deal.listedPrice || 0,
      specs: deal.specs || "",
      url: deal.url || "",
      savedAt: new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })
    });
    this.savedDeals.sort((a, b) => a.agreedPrice - b.agreedPrice);
    this.saveLocalState();
    scheduleGistSync();

    const text =
      `✅ <b>تم حفظ الصفقة بنجاح!</b>\n\n` +
      `💻 <b>الجهاز:</b> ${escapeHtml(deal.title)}\n` +
      `🤝 <b>السعر المتفق عليه:</b> <b>${agreedPrice}€</b>\n` +
      `🔗 <a href="${deal.url}">رابط الإعلان</a>\n\n` +
      `📌 لعرض جميع صفقاتك مرتبة من الأرخص للأغلى، اكتب /deals`;

    await this.sendHtml(chatId, text, {
      inline_keyboard: [[{ text: "📋 عرض جميع الصفقات المحفوظة", callback_data: "show_deals" }]]
    });
  }

  async sendSavedDealsList(chatId) {
    if (!this.savedDeals || this.savedDeals.length === 0) {
      await this.sendHtml(
        chatId,
        `📭 <b>لا توجد صفقات محفوظة بعد.</b>\n\nعندما تتفق مع أي بائع، ضع <b>لايك (👍)</b> على رسالة الإعلان أو اضغط <b>⭐ حفظ الصفقة</b> لتسجيلها!`
      );
      return;
    }

    const sorted = [...this.savedDeals].sort((a, b) => a.agreedPrice - b.agreedPrice);
    let text = `📋 <b>صفقاتك المحفوظة (مرتبة من الأقل للأعلى سعراً):</b>\n\n`;
    const deleteButtons = [];

    sorted.forEach((deal, idx) => {
      const rank = idx + 1;
      const savedDiff = deal.listedPrice > deal.agreedPrice
        ? ` (وفّرت ${deal.listedPrice - deal.agreedPrice}€)`
        : "";
      text +=
        `<b>${rank}. 💰 ${deal.agreedPrice}€</b>${savedDiff}\n` +
        `   💻 ${escapeHtml(deal.title)}\n` +
        `   🔗 <a href="${deal.url}">فتح الإعلان</a>\n` +
        `   📅 ${deal.savedAt || ""}\n\n`;

      deleteButtons.push([{ text: `🗑️ حذف #${rank} (${deal.agreedPrice}€)`, callback_data: `deldeal:${deal.adId}` }]);
    });

    await this.sendHtml(chatId, text, { inline_keyboard: deleteButtons });
  }

  async runAutonomousScan(triggerSource = "CLOUD_CYCLE") {
    if (this.isScanning) return { skipped: true, reason: "ALREADY_SCANNING" };
    if (!this.searchUrl || !this.token) return { skipped: true, reason: "NOT_CONFIGURED" };

    this.isScanning = true;
    let foundCount = 0;
    let qualifiedCount = 0;
    let sentNewCount = 0;
    const MAX_SEND_PER_CYCLE = 6;
    const isStartupScan = triggerSource === "STARTUP";

    try {
      const resp = await fetch(this.searchUrl, { headers: getHeaders() });
      if (!resp.ok) {
        this.consecutiveErrors++;
        throw new Error(`Kleinanzeigen HTTP ${resp.status}`);
      }
      this.consecutiveErrors = 0;

      const html = await resp.text();
      const listings = parseArticlesFromSearchHtml(html);
      foundCount = listings.length;

      // CRITICAL: On STARTUP, seed all current page-1 listings into cache WITHOUT sending notifications.
      // This guarantees the bot NEVER spams historical ads upon startup or restart!
      if (isStartupScan) {
        let seeded = 0;
        for (const ad of listings) {
          const idStr = String(ad.adId);
          if (!this.notifiedAds.includes(idStr)) {
            this.notifiedAds.push(idStr);
            seeded++;
          }
        }
        if (seeded > 0) {
          if (this.notifiedAds.length > 2000) this.notifiedAds = this.notifiedAds.slice(-1500);
          this.saveLocalState();
          scheduleGistSync();
          console.log(`[${this.id}:STARTUP] Baseline seeded: ${seeded} existing ads marked seen (zero spam).`);
        }
        this.lastScanStats = {
          time: new Date().toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin" }),
          found: foundCount,
          qualified: 0,
          sentNew: 0,
          error: null
        };
        return this.lastScanStats;
      }

      // Normal cycle: only genuinely new ads are evaluated and dispatched!
      for (const ad of listings) {
        const idStr = String(ad.adId);

        if (this.notifiedAds.includes(idStr)) {
          qualifiedCount++;
          continue;
        }

        if (this.seenRejectedIds.has(idStr)) continue;

        let parsed = RulesEngine.parseListing(ad.title, ad.snippetDesc, ad.priceText, ad.locationText, this.rules);
        if (!parsed.qualified) {
          this.seenRejectedIds.add(idStr);
          continue;
        }

        let details = { description: "", images: [], price: null };
        try {
          details = await fetchFullDetails(ad.adUrl);
        } catch (e) {}

        if (details.description) {
          parsed = RulesEngine.parseListing(ad.title, `${ad.snippetDesc} ${details.description}`, ad.priceText, ad.locationText, this.rules);
        }

        // Backup price from detail page if search snippet didn't have it
        if ((!parsed.price || parsed.price === 0) && details.price) {
          parsed.price = details.price;
        }

        if (!parsed.qualified) {
          this.seenRejectedIds.add(idStr);
          continue;
        }

        const evaluation = RulesEngine.evaluateDeal(parsed);
        if (!evaluation || evaluation.action === "IGNORE" || evaluation.action === "SKIP") {
          this.seenRejectedIds.add(idStr);
          continue;
        }

        qualifiedCount++;

        if (sentNewCount < MAX_SEND_PER_CYCLE) {
          const proposedMessage = this.sendSuggestedMessage ? this.buildProposedMessage(parsed, evaluation) : "";
          const itemData = {
            ...parsed,
            adId: ad.adId,
            title: ad.title,
            url: ad.adUrl,
            locationStr: ad.locationText
          };

          const dispatchRes = await this.dispatchDeal(itemData, evaluation, proposedMessage);
          if (dispatchRes.success) {
            sentNewCount++;
            this.notifiedAds.push(idStr);
            if (this.notifiedAds.length > 2000) this.notifiedAds = this.notifiedAds.slice(-1500);
            this.saveLocalState();
            scheduleGistSync();

            if (parsed.batteryHealth === null && details.images && details.images.length > 0) {
              this.inspectAdImagesAndUpdateTelegramAsync(itemData, evaluation, dispatchRes.messageId, dispatchRes.msg2Id, details.images);
            }

            await sleep(1000);
          }
        }
      }

      if (this.seenRejectedIds.size > 2000) {
        this.seenRejectedIds = new Set(Array.from(this.seenRejectedIds).slice(-1000));
      }

      this.lastScanStats = {
        time: new Date().toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin" }),
        found: foundCount,
        qualified: qualifiedCount,
        sentNew: sentNewCount,
        error: null
      };

      if (sentNewCount > 0 || triggerSource !== "CLOUD_CYCLE") {
        console.log(`[${this.id}:${triggerSource}] ${foundCount} ads | ${qualifiedCount} qualified | ${sentNewCount} NEW sent.`);
      }
      return this.lastScanStats;
    } catch (err) {
      console.error(`[${this.id}:${triggerSource}] Error:`, err.message);
      this.lastScanStats = {
        time: new Date().toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin" }),
        found: foundCount,
        qualified: qualifiedCount,
        sentNew: sentNewCount,
        error: err.message
      };
      return this.lastScanStats;
    } finally {
      this.isScanning = false;
    }
  }

  scheduleNextScan() {
    const jitterMs = Math.floor((Math.random() * 10) - 4) * 1000;
    const delayMs = Math.max(45000, (BASE_SCAN_SECONDS * 1000) + jitterMs);

    setTimeout(async () => {
      await this.runAutonomousScan("CLOUD_CYCLE");
      this.scheduleNextScan();
    }, delayMs);
  }

  async handleUpdate(update) {
    if (this.enableSaveDeals && update.message_reaction) {
      const mr = update.message_reaction;
      const chatId = mr.chat?.id;
      const msgId = String(mr.message_id);
      const newReactions = mr.new_reaction || [];
      const hasPositive = newReactions.some(r => r.type === "emoji" && ["👍", "❤️", "🔥", "⭐", "👏", "🤝", "💯"].includes(r.emoji));

      if (hasPositive && chatId) {
        const deal = this.sentMessages.byMsgId[msgId];
        if (deal) {
          this.pendingPriceByChat[String(chatId)] = deal;
          const buttons = [];
          if (deal.targetOffer) buttons.push([{ text: `💾 حفظ بالسعر المستهدف (${deal.targetOffer}€)`, callback_data: `qprice:${deal.adId}:${deal.targetOffer}` }]);
          if (deal.listedPrice) buttons.push([{ text: `💾 حفظ بسعر الإعلان (${deal.listedPrice}€)`, callback_data: `qprice:${deal.adId}:${deal.listedPrice}` }]);
          buttons.push([{ text: "❌ إلغاء", callback_data: "cancel_save" }]);
          await this.sendHtml(chatId, `👍 <b>ممتاز! اخترت حفظ هذه الصفقة:</b>\n\n💻 <b>${escapeHtml(deal.title)}</b>\n\n💰 <b>كم السعر النهائي المتفق عليه مع البائع؟</b>`, { inline_keyboard: buttons });
        }
      }
      return;
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      const data = cb.data || "";
      await this.tgApi("answerCallbackQuery", { callback_query_id: cb.id });

      if (data.startsWith("save:")) {
        const adId = data.slice(5);
        const deal = this.sentMessages.byAdId[adId] || this.sentMessages.byMsgId[String(cb.message?.message_id)];
        if (deal) {
          this.pendingPriceByChat[String(chatId)] = deal;
          const buttons = [];
          if (deal.targetOffer) buttons.push([{ text: `💾 حفظ بالسعر المستهدف (${deal.targetOffer}€)`, callback_data: `qprice:${deal.adId}:${deal.targetOffer}` }]);
          if (deal.listedPrice) buttons.push([{ text: `💾 حفظ بسعر الإعلان (${deal.listedPrice}€)`, callback_data: `qprice:${deal.adId}:${deal.listedPrice}` }]);
          buttons.push([{ text: "❌ إلغاء", callback_data: "cancel_save" }]);
          await this.sendHtml(chatId, `👍 <b>ممتاز! اخترت حفظ هذه الصفقة:</b>\n\n💻 <b>${escapeHtml(deal.title)}</b>\n\n💰 <b>كم السعر النهائي المتفق عليه مع البائع؟</b>`, { inline_keyboard: buttons });
        }
        return;
      }

      if (data.startsWith("qprice:")) {
        const parts = data.split(":");
        const adId = parts[1];
        const price = parseInt(parts[2], 10);
        const deal = this.pendingPriceByChat[String(chatId)] || this.sentMessages.byAdId[adId];
        if (deal && !isNaN(price)) {
          await this.completeSaveDeal(chatId, deal, price);
        }
        return;
      }

      if (data.startsWith("deldeal:")) {
        const adId = data.slice(8);
        this.savedDeals = this.savedDeals.filter(d => String(d.adId) !== String(adId));
        this.saveLocalState();
        scheduleGistSync();
        await this.sendHtml(chatId, "🗑️ تم حذف الصفقة.");
        await this.sendSavedDealsList(chatId);
        return;
      }

      if (data === "show_deals") {
        await this.sendSavedDealsList(chatId);
        return;
      }

      if (data === "cancel_save") {
        delete this.pendingPriceByChat[String(chatId)];
        await this.sendHtml(chatId, "❎ تم إلغاء حفظ الصفقة.");
        return;
      }

      if (data.startsWith("dismiss:")) {
        await this.tgApi("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: cb.message?.message_id,
          reply_markup: { inline_keyboard: [[{ text: "✖️ تم التجاهل", callback_data: "noop" }]] }
        });
        return;
      }
      return;
    }

    if (update.message && update.message.text) {
      const msg = update.message;
      const chatId = String(msg.chat.id);
      const text = msg.text.trim();

      const isSubscribed = this.subscribers.includes(chatId);
      const maxSubs = typeof this.cfg.maxSubscribers === "number" ? this.cfg.maxSubscribers : 2;

      if (!isSubscribed) {
        if (this.subscribers.length >= maxSubs) {
          console.log(`[${this.id}] Blocked unauthorized user ${chatId} (${msg.from?.first_name || ""}) - bot locked.`);
          await this.sendHtml(
            chatId,
            `⛔ <b>عذراً، هذا البوت خاص ومقفل للمشتركين المصرح لهم فقط.</b>\nلا يمكن استقبال مستخدمين جدد.`
          );
          return;
        }

        this.subscribers.push(chatId);
        this.saveLocalState();
        scheduleGistSync();
        console.log(`[${this.id}] Registered new friend: ${chatId} (${msg.from?.first_name || ""}). Total: ${this.subscribers.length}/${maxSubs}`);

        if (this.cfg.telegramChatId && chatId !== String(this.cfg.telegramChatId)) {
          const friendName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "صديقك";
          const usernameStr = msg.from?.username ? ` (@${msg.from.username})` : "";
          await this.sendHtml(
            this.cfg.telegramChatId,
            `🔔 <b>تنبيه من ${escapeHtml(this.name)}:</b>\n\n` +
            `👤 قام <b>${escapeHtml(friendName)}</b>${usernameStr} بالاشتراك في البوت الآن بنجاح! ✅\n` +
            `🔒 <b>تم قفل البوت تلقائياً؛</b> أصبح مخصصاً لك وله فقط وممنوع على أي شخص آخر نهائياً.`
          );
        }
      }

      if (this.pendingPriceByChat[String(chatId)] && !text.startsWith("/")) {
        const priceMatch = text.match(/(\d{2,4})/);
        if (priceMatch) {
          const agreedPrice = parseInt(priceMatch[1], 10);
          const deal = this.pendingPriceByChat[String(chatId)];
          await this.completeSaveDeal(chatId, deal, agreedPrice);
          return;
        } else {
          await this.sendHtml(chatId, "⚠️ يرجى إرسال رقم السعر فقط (مثلاً: <code>350</code>).");
          return;
        }
      }

      if (text === "/deals" || text.includes("صفقات") || text.includes("المحفوظة")) {
        await this.sendSavedDealsList(chatId);
        return;
      }

      if (text === "/start" || text === "ابدأ" || text === "القائمة") {
        let cityDesc = "هانوفر وما حولها (120 كم)";
        if (this.rules.targetCity === "hamburg") cityDesc = "مدينة هامبورغ حصراً";
        if (this.rules.targetCity === "halle") cityDesc = "مدينة هالة زالة (وحتى 40 كم)";

        let welcomeText =
          `🍎 <b>أهلاً بك في ${escapeHtml(this.name)}!</b>\n\n` +
          `✅ <b>الاشتراك مفعّل تلقائياً</b> على هذا الشات.\n` +
          `📍 <b>نطاق البحث:</b> ${cityDesc}\n` +
          `⚡ <b>الفحص السحابي 24/7:</b> يعمل ذاتياً في السحابة بدون توقف.\n` +
          `🎯 <b>المعايير:</b> أجهزة MacBook معالجات Apple Silicon (M1..M5) ببطارية 90% فأكثر وبدون أي عيوب.\n\n` +
          `ستصلك الإعلانات فور نزولها مباشرة مع رابط سريع للفتح في تطبيق Kleinanzeigen!`;

        await this.sendHtml(chatId, welcomeText);
        return;
      }

      if (text === "/scan" || text.includes("فحص")) {
        await this.sendHtml(chatId, "⏳ <b>جاري فحص أحدث الإعلانات الآن سحابياً...</b>");
        const stats = await this.runAutonomousScan("MANUAL_CMD");
        await this.sendHtml(chatId, `✅ <b>انتهى الفحص:</b> عُثر على ${stats.found} إعلان (${stats.qualified} مؤهل، و${stats.sentNew} جديدة أُرسلت).`);
        return;
      }

      if (text === "/status") {
        const stats = this.lastScanStats;
        await this.sendHtml(chatId, `📊 <b>حالة البوت السحابي (${escapeHtml(this.name)}):</b>\n• المشتركون: <b>${this.subscribers.length}</b>\n• البيئة: <b>سحابة GitHub Actions 24/7</b>\n• آخر فحص: <b>${stats.time || "جاري..."}</b>\n• النتائج: <b>${stats.found} إعلان (${stats.qualified} مؤهل)</b>\n• الإعلانات المسجلة: <b>${this.notifiedAds.length}</b>`);
        return;
      }
    }
  }

  async pollUpdates() {
    if (!this.token) return;
    try {
      const res = await this.tgApi("getUpdates", {
        offset: this.lastUpdateId + 1,
        timeout: 20,
        allowed_updates: ["message", "callback_query", "message_reaction"]
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      }
    } catch (err) {
      // Ignore polling errors
    }
    setTimeout(() => this.pollUpdates(), 1000);
  }

  async initCommands() {
    if (!this.token) return;
    await this.tgApi("setMyCommands", {
      commands: [
        { command: "scan", description: "⚡ فحص الإعلانات الآن" },
        { command: "status", description: "📊 حالة البوت وآخر فحص" },
        { command: "start", description: "🏠 تفعيل الاشتراك ومعلومات البوت" }
      ]
    });
  }

  start() {
    this.initCommands().catch(() => {});
    this.pollUpdates();
    setTimeout(async () => {
      await this.runAutonomousScan("STARTUP");
      this.scheduleNextScan();
    }, 1500 + Math.floor(Math.random() * 2500));
  }
}

// ==========================================
// Multi-Bot Master Controller & Gist Sync
// ==========================================

const activeBots = [];
let gistSyncTimer = null;

async function loadAllStateFromGist() {
  if (!GITHUB_TOKEN || !GITHUB_GIST_ID) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${GITHUB_GIST_ID}`, {
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "cloud-macbook-hunter"
      }
    });
    if (!res.ok) {
      console.warn(`[Gist] Read failed: HTTP ${res.status}`);
      return;
    }
    const gist = await res.json();
    const raw = gist.files?.["bot-state.json"]?.content;
    if (!raw) return;
    const cleanJson = raw.replace(/^\uFEFF/, "").trim();
    const state = JSON.parse(cleanJson);

    for (const bot of activeBots) {
      const bState = state.bots?.[bot.id];
      if (bState) {
        if (Array.isArray(bState.notifiedAds)) {
          bot.notifiedAds = [...new Set([...bot.notifiedAds, ...bState.notifiedAds])].slice(-1500);
        }
        if (Array.isArray(bState.subscribers)) {
          bot.subscribers = [...new Set([...bot.subscribers, ...bState.subscribers])];
        }
        if (Array.isArray(bState.savedDeals)) {
          bot.savedDeals = bState.savedDeals;
        }
        if (bState.sentMessages) {
          bot.sentMessages = bState.sentMessages;
        }
      } else if (bot.id === "macbook-m") {
        if (Array.isArray(state.notifiedAds)) {
          bot.notifiedAds = [...new Set([...bot.notifiedAds, ...state.notifiedAds])].slice(-1500);
        }
        if (Array.isArray(state.savedDeals)) {
          bot.savedDeals = state.savedDeals;
        }
        if (state.sentMessages) {
          bot.sentMessages = state.sentMessages;
        }
      }

      // Also inherit top-level global notifiedAds to guarantee zero duplicate alerts
      if (Array.isArray(state.notifiedAds)) {
        bot.notifiedAds = [...new Set([...bot.notifiedAds, ...state.notifiedAds])].slice(-1500);
      }

      bot.saveLocalState();
    }
    console.log(`[Gist] Restored cloud state successfully across ${activeBots.length} bots.`);
  } catch (e) {
    console.error("[Gist] Load state error:", e.message);
  }
}

async function flushGistSync() {
  if (!GITHUB_TOKEN || !GITHUB_GIST_ID) return;
  try {
    const botsState = {};
    const globalNotified = new Set();
    let primarySavedDeals = [];

    for (const bot of activeBots) {
      botsState[bot.id] = {
        notifiedAds: bot.notifiedAds.slice(-1500),
        subscribers: bot.subscribers,
        savedDeals: bot.savedDeals,
        sentMessages: {
          byMsgId: Object.fromEntries(Object.entries(bot.sentMessages.byMsgId || {}).slice(-200)),
          byAdId: Object.fromEntries(Object.entries(bot.sentMessages.byAdId || {}).slice(-200))
        }
      };
      bot.notifiedAds.forEach(id => globalNotified.add(id));
      if (bot.id === "macbook-m") {
        primarySavedDeals = bot.savedDeals;
      }
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      bots: botsState,
      notifiedAds: Array.from(globalNotified).slice(-2000),
      savedDeals: primarySavedDeals
    };

    const res = await fetch(`https://api.github.com/gists/${GITHUB_GIST_ID}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "cloud-macbook-hunter"
      },
      body: JSON.stringify({
        description: "MacBook Bots 24/7 Multi-Hunter State",
        files: {
          "bot-state.json": { content: JSON.stringify(payload, null, 2) }
        }
      })
    });
    if (res.ok) {
      console.log(`[Gist] Cloud state synced (${globalNotified.size} global ads).`);
    } else {
      console.warn(`[Gist] Patch failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error("[Gist] Sync error:", e.message);
  }
}

function scheduleGistSync() {
  if (gistSyncTimer) clearTimeout(gistSyncTimer);
  gistSyncTimer = setTimeout(() => {
    flushGistSync().catch(() => {});
  }, 2500);
}

async function triggerNextCloudRunner() {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return;
  try {
    console.log(`[Cloud Master] Daisy-chaining next runner via workflow dispatch on ${GITHUB_REPOSITORY}...`);
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/cloud-hunter.yml/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "cloud-macbook-hunter"
      },
      body: JSON.stringify({ ref: "main" })
    });
    console.log(`[Cloud Master] Next runner dispatch status: HTTP ${res.status}`);
  } catch (e) {
    console.error("[Cloud Master] Error dispatching next runner:", e.message);
  }
}

function getRegistryConfig() {
  if (process.env.BOT_CONFIG_JSON) {
    try {
      return JSON.parse(process.env.BOT_CONFIG_JSON);
    } catch (e) {
      console.error("[Config] Error parsing BOT_CONFIG_JSON env:", e.message);
    }
  }

  const localPath = path.join(__dirname, "config", "bots-registry.json");
  if (fs.existsSync(localPath)) {
    return loadJson(localPath, { bots: [] });
  }

  throw new Error("FATAL: No BOT_CONFIG_JSON environment secret found.");
}

async function main() {
  console.log(`=========================================================`);
  console.log(`☁️ 24/7 Autonomous MacBook Cloud Hunter Initializing...`);
  console.log(`🕒 Shift Duration: ${SHIFT_MINUTES} minutes`);
  console.log(`🔒 Gist State Sync: ${GITHUB_GIST_ID ? "ENABLED" : "DISABLED"}`);
  console.log(`=========================================================`);

  const registry = getRegistryConfig();
  for (const bCfg of registry.bots) {
    if (bCfg.enabled && bCfg.telegramBotToken) {
      const instance = new BotHunterInstance(bCfg);
      activeBots.push(instance);
      console.log(`[Master] Loaded Bot: ${bCfg.name} (${bCfg.id})`);
    }
  }

  await loadAllStateFromGist();

  for (const bot of activeBots) {
    bot.start();
  }

  async function cleanupAndExit() {
    console.log("[Cloud Master] Concluding shift. Flushing state to Gist...");
    await flushGistSync();
    console.log("[Cloud Master] Shift ended cleanly.");
    process.exit(0);
  }

  process.on("SIGINT", cleanupAndExit);
  process.on("SIGTERM", cleanupAndExit);

  const triggerNextDelayMs = (SHIFT_MINUTES - 1) * 60 * 1000;
  setTimeout(async () => {
    await triggerNextCloudRunner();
  }, triggerNextDelayMs);

  const shiftTimeoutMs = SHIFT_MINUTES * 60 * 1000;
  setTimeout(async () => {
    await cleanupAndExit();
  }, shiftTimeoutMs);
}

main().catch(err => {
  console.error("[Fatal Error]", err);
  process.exit(1);
});
