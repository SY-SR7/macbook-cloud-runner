/**
 * Kleinanzeigen MacBook Deal Hunter - Rules & Pricing Engine
 * Implements 100% of user-defined constraints:
 * - Apple Silicon only (M1, M2, M3, M4, M5), Pro or Air.
 * - Hardware defects strictly excluded.
 * - Max 120 km from 30167 Hannover.
 * - Battery health >= 90% required (if unknown, triggers battery-inquiry state).
 * - Exact pricing matrix for Air and Pro with fallback caps and polite rejection states.
 * - M Pro/Max < 1000€ triggers Telegram notification.
 */

// Exact Price Matrix as specified by User
const PRICE_RULES = {
  air: {
    m1: {
      "256_8": { offer: 285, max: 285, fallbackReject: true },
      "256_16": { offer: 350, max: 350, fallbackReject: true },
      "512_8": { offer: 350, max: 350, fallbackReject: true },
      "512_16": { offer: 400, max: 400, fallbackReject: true }
    },
    m2: {
      "256_8": {
        // 350€ if listed < 460€, 400€ if listed >= 460€
        dynamicOffer: (listedPrice) => (listedPrice < 460 ? 350 : 400),
        max: (listedPrice) => (listedPrice < 460 ? 350 : 400),
        fallbackReject: true
      },
      "256_16": { offer: 450, max: 450, fallbackReject: true },
      "512_8": { offer: 450, max: 450, fallbackReject: true },
      "512_16": { offer: 500, max: 550, fallbackReject: false } // max 550€ if 500€ rejected
    },
    m3: {
      "256_8": { offer: 550, max: 600, fallbackReject: false }, // max 600€ if rejected
      "256_16": { offer: 600, max: 630, fallbackReject: false }, // max 630€ if rejected
      "512_8": { offer: 600, max: 630, fallbackReject: false },  // max 630€ if rejected
      "512_16": { offer: 650, max: 680, fallbackReject: false }  // max 680€ if rejected
    },
    m4: {
      "256_8": { offer: 550, max: 550, fallbackReject: true },
      "256_16": { offer: 600, max: 600, fallbackReject: true },
      "512_8": { offer: 600, max: 600, fallbackReject: true },
      "512_16": { offer: 700, max: 700, fallbackReject: true }
    },
    m5: {
      "256_8": { offer: 650, max: 650, fallbackReject: true },
      "256_16": { offer: 700, max: 700, fallbackReject: true },
      "512_8": { offer: 700, max: 700, fallbackReject: true },
      "512_16": {
        // If listed < 950€ -> offer 700€, else skip
        condition: (listedPrice) => listedPrice < 950,
        offer: 700,
        max: 700,
        fallbackReject: true
      }
    }
  },
  pro: {
    m1: {
      "256_8": { offer: 350, max: 350, fallbackReject: true },
      "256_16": { offer: 400, max: 400, fallbackReject: true },
      "512_8": { offer: 400, max: 400, fallbackReject: true },
      "512_16": { offer: 450, max: 450, fallbackReject: true }
    },
    m2: {
      "256_8": {
        // 400€ if listed < 540€, 450€ if listed >= 540€
        dynamicOffer: (listedPrice) => (listedPrice < 540 ? 400 : 450),
        max: (listedPrice) => (listedPrice < 540 ? 400 : 450),
        fallbackReject: true
      },
      "256_16": { offer: 500, max: 500, fallbackReject: true },
      "512_8": { offer: 500, max: 500, fallbackReject: true },
      "512_16": { offer: 550, max: 600, fallbackReject: false } // max 600€ if 550€ rejected
    },
    m3: {
      "256_8": { offer: 550, max: 600, fallbackReject: false }, // max 600€ if rejected
      "256_16": { offer: 650, max: 680, fallbackReject: false }, // max 680€ if rejected
      "512_8": { offer: 650, max: 680, fallbackReject: false },  // max 680€ if rejected
      "512_16": { offer: 650, max: 680, fallbackReject: false }  // max 680€ if rejected
    },
    m4: {
      "256_8": { offer: 600, max: 600, fallbackReject: true },
      "256_16": { offer: 650, max: 650, fallbackReject: true },
      "512_8": { offer: 650, max: 650, fallbackReject: true },
      "512_16": {
        // 700€ if listed <= 1000€
        condition: (listedPrice) => listedPrice <= 1000,
        offer: 700,
        max: 700,
        fallbackReject: true
      }
    },
    m5: {
      "256_8": {
        condition: (listedPrice) => listedPrice <= 950,
        offer: 650,
        max: 650,
        fallbackReject: true
      },
      "256_16": {
        condition: (listedPrice) => listedPrice <= 1000,
        offer: 700,
        max: 700,
        fallbackReject: true
      },
      "512_8": {
        condition: (listedPrice) => listedPrice <= 1000,
        offer: 700,
        max: 700,
        fallbackReject: true
      },
      "512_16": {
        // Never buy ("مستحيل جيبه")
        condition: () => false,
        skipReason: "M5 Pro 512/16 is excluded per user rules."
      }
    }
  }
};

// Hardware defect keywords in German
const DEFECT_KEYWORDS = [
  "defekt",
  "beschädigt",
  "displayriss",
  "glasbruch",
  "bruch",
  "wasserschaden",
  "flüssigkeitsschaden",
  "funktioniert nicht",
  "geht nicht an",
  "kein bild",
  "streifen im display",
  "pixel fehler",
  "tastatur defekt",
  "trackpad defekt",
  "icloud gesperrt",
  "aktivierungssperre",
  "gesperrt",
  "mdm gesperrt",
  "für bastler",
  "bastlergerät",
  "ersatzteilspender"
];

// Benign cosmetic condition keywords (these are OK)
const BENIGN_KEYWORDS = [
  "gebrauchsspuren",
  "leichte kratzer",
  "feine kratzer",
  "mikrokratzer",
  "normale spuren",
  "voll funktionsfähig",
  "einwandfrei",
  "technisch einwandfrei",
  "sehr guter zustand",
  "wie neu"
];

// Accessory / Non-laptop keywords to eliminate bags, cases, chargers, etc.
const ACCESSORY_KEYWORDS = [
  "hülle", "tasche", "case", "sleeve", "schutzhülle", "ladekabel",
  "netzteil", "adapter", "karton", "nur ovp", "leerkarton", "dummy", "ständer", "dock"
];

class RulesEngine {
  static customPriceRules = null;
  static customDefects = null;
  static customAccessories = null;

  static setCustomPriceRules(rules) {
    this.customPriceRules = rules;
  }

  static async loadCustomizations() {
    if (typeof BotStorage !== "undefined") {
      const savedPrices = await BotStorage.get("km_custom_prices", null);
      if (savedPrices) {
        this.applyCustomPriceMap(savedPrices);
      }
      const savedFilters = await BotStorage.get("km_custom_filters", null);
      if (savedFilters) {
        if (savedFilters.accessories) {
          this.customAccessories = savedFilters.accessories.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        }
        if (savedFilters.defects) {
          this.customDefects = savedFilters.defects.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        }
      }
    }
  }

  static applyCustomPriceMap(map) {
    const rules = JSON.parse(JSON.stringify(PRICE_RULES));
    // Air
    if (map.p_air_m1_256_8) { rules.air.m1["256_8"].offer = map.p_air_m1_256_8; rules.air.m1["256_8"].max = map.p_air_m1_256_8_max || map.p_air_m1_256_8; }
    if (map.p_air_m1_512_8) { rules.air.m1["512_8"].offer = map.p_air_m1_512_8; rules.air.m1["256_16"].offer = map.p_air_m1_512_8; }
    if (map.p_air_m1_512_16) { rules.air.m1["512_16"].offer = map.p_air_m1_512_16; rules.air.m1["512_16"].max = map.p_air_m1_512_16_max || map.p_air_m1_512_16; }

    if (map.p_air_m2_512_8) { rules.air.m2["512_8"].offer = map.p_air_m2_512_8; rules.air.m2["256_16"].offer = map.p_air_m2_512_8; }
    if (map.p_air_m2_512_16) { rules.air.m2["512_16"].offer = map.p_air_m2_512_16; rules.air.m2["512_16"].max = map.p_air_m2_512_16_max || map.p_air_m2_512_16; }

    if (map.p_air_m3_256_8) { rules.air.m3["256_8"].offer = map.p_air_m3_256_8; rules.air.m3["256_8"].max = map.p_air_m3_256_8_max || map.p_air_m3_256_8; }
    if (map.p_air_m3_512_8) { rules.air.m3["512_8"].offer = map.p_air_m3_512_8; rules.air.m3["512_8"].max = map.p_air_m3_512_8_max || map.p_air_m3_512_8; }
    if (map.p_air_m3_512_16) { rules.air.m3["512_16"].offer = map.p_air_m3_512_16; rules.air.m3["512_16"].max = map.p_air_m3_512_16_max || map.p_air_m3_512_16; }

    if (map.p_air_m4_256_8) { rules.air.m4["256_8"].offer = map.p_air_m4_256_8; }
    if (map.p_air_m4_512_8) { rules.air.m4["512_8"].offer = map.p_air_m4_512_8; rules.air.m4["256_16"].offer = map.p_air_m4_512_8; }
    if (map.p_air_m4_512_16) { rules.air.m4["512_16"].offer = map.p_air_m4_512_16; }

    if (map.p_air_m5_256_8) { rules.air.m5["256_8"].offer = map.p_air_m5_256_8; }
    if (map.p_air_m5_512_8) { rules.air.m5["512_8"].offer = map.p_air_m5_512_8; }
    if (map.p_air_m5_512_16) { rules.air.m5["512_16"].offer = map.p_air_m5_512_16; }

    // Pro
    if (map.p_pro_m1_256_8) { rules.pro.m1["256_8"].offer = map.p_pro_m1_256_8; }
    if (map.p_pro_m1_512_8) { rules.pro.m1["512_8"].offer = map.p_pro_m1_512_8; rules.pro.m1["256_16"].offer = map.p_pro_m1_512_8; }
    if (map.p_pro_m1_512_16) { rules.pro.m1["512_16"].offer = map.p_pro_m1_512_16; }

    if (map.p_pro_m2_512_8) { rules.pro.m2["512_8"].offer = map.p_pro_m2_512_8; rules.pro.m2["256_16"].offer = map.p_pro_m2_512_8; }
    if (map.p_pro_m2_512_16) { rules.pro.m2["512_16"].offer = map.p_pro_m2_512_16; rules.pro.m2["512_16"].max = map.p_pro_m2_512_16_max || map.p_pro_m2_512_16; }

    if (map.p_pro_m3_256_8) { rules.pro.m3["256_8"].offer = map.p_pro_m3_256_8; rules.pro.m3["256_8"].max = map.p_pro_m3_256_8_max || map.p_pro_m3_256_8; }
    if (map.p_pro_m3_512_8) { rules.pro.m3["512_8"].offer = map.p_pro_m3_512_8; rules.pro.m3["512_8"].max = map.p_pro_m3_512_8_max || map.p_pro_m3_512_8; }
    if (map.p_pro_m3_512_16) { rules.pro.m3["512_16"].offer = map.p_pro_m3_512_16; rules.pro.m3["512_16"].max = map.p_pro_m3_512_16_max || map.p_pro_m3_512_16; }

    if (map.p_pro_m4_256_8) { rules.pro.m4["256_8"].offer = map.p_pro_m4_256_8; }
    if (map.p_pro_m4_512_8) { rules.pro.m4["512_8"].offer = map.p_pro_m4_512_8; }
    if (map.p_pro_m4_512_16) { rules.pro.m4["512_16"].offer = map.p_pro_m4_512_16; }

    if (map.p_pro_m5_256_8) { rules.pro.m5["256_8"].offer = map.p_pro_m5_256_8; }
    if (map.p_pro_m5_512_8) { rules.pro.m5["512_8"].offer = map.p_pro_m5_512_8; }

    this.customPriceRules = rules;
  }

  static getPriceRules() {
    return this.customPriceRules || PRICE_RULES;
  }

  static setCustomKeywords(defects, accessories) {
    if (Array.isArray(defects)) this.customDefects = defects;
    if (Array.isArray(accessories)) this.customAccessories = accessories;
  }

  static getDefectKeywords() {
    return this.customDefects || DEFECT_KEYWORDS;
  }

  static getAccessoryKeywords() {
    return this.customAccessories || ACCESSORY_KEYWORDS;
  }

  /**
   * Parse listing text to extract MacBook model, specs, battery, and defects.
   */
  static parseListing(title, description, rawPrice = 0, locationStr = "", options = {}) {
    const text = `${title} ${description}`.toLowerCase();
    const result = {
      isAppleSilicon: false,
      modelType: null, // "air" | "pro"
      chipGeneration: null, // "m1" | "m2" | "m3" | "m4" | "m5"
      isMProOrMax: false, // M1 Pro, M2 Max, etc.
      ram: null, // 8, 16, 24, etc.
      ssd: null, // 256, 512, 1000 (1TB)
      batteryHealth: null, // number e.g. 94 or null
      hasDefect: false,
      defectReason: null,
      isInHannover: false,
      distanceKm: null,
      price: typeof rawPrice === "number" ? rawPrice : this.extractPrice(rawPrice)
    };

    // 0. Filter out price limits if provided
    if (result.price > 0 && (result.price < 250 || result.price > 1000)) {
      return { ...result, qualified: false, rejectReason: `Price ${result.price}€ outside target range 250€-1000€` };
    }

    // 0b. Filter out accessories, covers, bags in title
    const titleLower = title.toLowerCase();
    for (const acc of this.getAccessoryKeywords()) {
      if (titleLower.includes(acc) && !titleLower.includes("inkl") && !titleLower.includes("mit")) {
        return { ...result, qualified: false, rejectReason: `Filtered accessory / case: "${acc}"` };
      }
    }

    // 1. Detect Intel / non-M / pre-2020 exclusion (M1 launched late 2020)
    if (
      text.includes("intel") ||
      /\b(i3|i5|i7|i9|a18|core\s*duo|core\s*2)\b/i.test(text) ||
      /\b(201[0-9])\b/.test(text)
    ) {
      return { ...result, qualified: false, rejectReason: "Intel or pre-2020 MacBook detected (Apple Silicon M-series only)" };
    }

    const missingSpecs = [];

    // 2. Detect Chip Generation
    const mMatch = text.match(/\bm([1-5])\b/i);
    if (mMatch) {
      result.isAppleSilicon = true;
      result.chipGeneration = `m${mMatch[1]}`;
    } else if (text.includes("apple silicon") || text.includes("m-chip")) {
      result.isAppleSilicon = true;
      missingSpecs.push("chip"); // Known to be M, but which one? M1, M2...
    } else {
      // Not specified if it's M or Intel
      missingSpecs.push("chip");
    }

    // 3. Detect M Pro / M Max chips
    if (/\bm[1-5]\s*(pro|max)\b/i.test(text) || text.includes("m1 pro") || text.includes("m2 pro") || text.includes("m3 pro") || text.includes("m4 pro")) {
      result.isMProOrMax = true;
    }

    // 4. Detect Model Type (Air vs Pro)
    const hasAir = text.includes("macbook air") || /\bair\b/i.test(text);
    const hasPro = text.includes("macbook pro") || /\bpro\b/i.test(text);
    if (hasAir && !hasPro) {
      result.modelType = "air";
    } else if (hasPro && !hasAir) {
      result.modelType = "pro";
    } else if (hasAir && hasPro) {
      // Ambiguous title e.g. "Macbook Air / Pro"
      missingSpecs.push("modelType");
    } else {
      missingSpecs.push("modelType");
    }

    // 5. Detect RAM
    const ramMatch = text.match(/\b(8|16|18|24|32|36|64)\s*(?:gb|g|ram)\b/i) ||
      text.match(/(?:arbeitsspeicher|ram)[\s\:\=]*(8|16|18|24|32|36|64)\b/i);
    if (ramMatch) {
      result.ram = parseInt(ramMatch[1] || ramMatch[2], 10);
    } else {
      missingSpecs.push("ram");
    }

    // 6. Detect SSD
    const ssdMatch = text.match(/\b(256|512|1000|1024|1\s*tb|2\s*tb)\s*(?:gb|g|tb|ssd)?\b/i) ||
      text.match(/(?:festplatte|ssd|speicher)[\s\:\=]*(256|512|1\s*tb|2\s*tb|1000)\b/i);
    if (ssdMatch) {
      const val = ssdMatch[1].replace(/\s+/g, "").toLowerCase();
      if (val === "1tb" || val === "1000" || val === "1024" || val === "2tb") result.ssd = 512; // group >= 512
      else result.ssd = parseInt(val, 10);
    } else {
      missingSpecs.push("ssd");
    }

    // 7. Defect Check
    for (const defectWord of this.getDefectKeywords()) {
      if (text.includes(defectWord)) {
        // Verify it's not negated (e.g., "kein defekt", "nicht defekt")
        const idx = text.indexOf(defectWord);
        const prefix = text.substring(Math.max(0, idx - 20), idx);
        if (!prefix.includes("kein") && !prefix.includes("nicht") && !prefix.includes("ohne")) {
          result.hasDefect = true;
          result.defectReason = defectWord;
          return { ...result, qualified: false, rejectReason: `Hardware defect detected: "${defectWord}"` };
        }
      }
    }

    // 8. Battery Health Check
    result.batteryHealth = this.extractBatteryHealth(text);
    if (result.batteryHealth !== null && result.batteryHealth < 90) {
      return {
        ...result,
        qualified: false,
        rejectReason: `Battery health is ${result.batteryHealth}% (below required 90%)`
      };
    }
    if (result.batteryHealth === null) {
      missingSpecs.push("battery");
    }

    // 9. Location & Distance Check (supports Hannover, Hamburg, Halle, etc.)
    const locLower = locationStr.toLowerCase();
    const targetCity = (options.targetCity || "hannover").toLowerCase();
    const maxDistance = typeof options.maxDistanceKm === "number" ? options.maxDistanceKm : 120;
    const strictCityOnly = Boolean(options.strictCityOnly || maxDistance === 0);

    const kmMatch = locLower.match(/(\d+)\s*km/);
    if (kmMatch) {
      result.distanceKm = parseInt(kmMatch[1], 10);
    } else {
      result.distanceKm = 0;
    }

    if (targetCity === "hamburg" || targetCity === "22769") {
      const isHamburg = locLower.includes("hamburg") || /\b2[0-2][0-9]{3}\b/.test(locLower) || locLower.includes("harburg") || locLower.includes("altona");
      result.isInTargetCity = isHamburg && result.distanceKm === 0;
      result.isInHannover = false;
      if (strictCityOnly && (!isHamburg || result.distanceKm > 0)) {
        return { ...result, qualified: false, rejectReason: `Location is outside Hamburg (${locationStr})` };
      }
      if (result.distanceKm > maxDistance) {
        return { ...result, qualified: false, rejectReason: `Distance ${result.distanceKm} km exceeds max ${maxDistance} km from Hamburg (22769)` };
      }
    } else if (targetCity === "halle" || targetCity === "halle-saale" || targetCity.includes("halle")) {
      const isHalle = locLower.includes("halle") || /\b061[0-9]{2}\b/.test(locLower);
      result.isInTargetCity = isHalle && result.distanceKm === 0;
      result.isInHannover = false;
      if (result.distanceKm > maxDistance) {
        return { ...result, qualified: false, rejectReason: `Distance ${result.distanceKm} km exceeds max ${maxDistance} km from Halle` };
      }
    } else {
      // Default: Hannover (30167)
      if (locLower.includes("hannover") || locLower.includes("30167") || /\b30[0-9]{3}\b/.test(locLower)) {
        result.isInHannover = true;
        result.distanceKm = 0;
        result.isInTargetCity = true;
      } else {
        result.isInHannover = false;
        result.isInTargetCity = false;
        if (result.distanceKm > maxDistance) {
          return { ...result, qualified: false, rejectReason: `Distance ${result.distanceKm} km exceeds max ${maxDistance} km` };
        }
      }
    }

    result.missingSpecs = missingSpecs;
    return { ...result, qualified: true };
  }

  /**
   * Extract battery health percentage from text or description.
   * Cleans markdown symbols (*, _, ~, #) to cleanly catch e.g. "Akku: 91 **% Kapazität***".
   */
  static extractBatteryHealth(rawText) {
    if (!rawText) return null;

    // 1. Sanitize text: replace markdown asterisks, underscores, html tags, backticks with spaces
    const text = rawText
      .replace(/<[^>]*>/g, " ")
      .replace(/[\*_~`#\\|]/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .toLowerCase();

    // Pattern 1: keyword followed by percentage: "akku 94%", "maximale kapazität 91 %", "batteriezustand: 100%"
    const p1 = /(?:akku(?:kapazität|zustand|leistung)?|batterie(?:zustand|kapazität)?|maximale\s+kapazität|maximum\s+capacity|restkapazität|kapazität|capacity|health)[^0-9%\n]{0,35}(\d{2,3})\s*%/i;
    const m1 = text.match(p1);
    if (m1) {
      const val = parseInt(m1[1], 10);
      if (val >= 40 && val <= 100) return val;
    }

    // Pattern 2: percentage followed by keyword: "91% akku", "95% batterie", "100% kapazität"
    const p2 = /(\d{2,3})\s*%\s*(?:akku(?:kapazität|zustand)?|batterie(?:zustand|kapazität)?|health|kapazität|restkapazität)/i;
    const m2 = text.match(p2);
    if (m2) {
      const val = parseInt(m2[1], 10);
      if (val >= 40 && val <= 100) return val;
    }

    // Pattern 3: keyword followed by pure number without %: "akku: 91", "akkuzustand 95"
    const p3 = /(?:akku(?:kapazität|zustand)?|batterie(?:zustand|kapazität)?|maximale\s+kapazität|maximum\s+capacity)[\s\:\-\=]+(\d{2,3})\b/i;
    const m3 = text.match(p3);
    if (m3) {
      const val = parseInt(m3[1], 10);
      if (val >= 50 && val <= 100) return val;
    }

    // Pattern 4: German text phrasing e.g. "akku liegt bei 91", "akku hat 92"
    const p4 = /(?:akku|batterie)\s+(?:liegt\s+bei|hat|ist\s+bei)\s+(\d{2,3})/i;
    const m4 = text.match(p4);
    if (m4) {
      const val = parseInt(m4[1], 10);
      if (val >= 50 && val <= 100) return val;
    }

    // Pattern 5: Standalone percentage in title/text (e.g. "MacBook Air M1 87%" or "M2 13 Zoll 94%")
    const standaloneMatch = text.match(/\b([5-9][0-9]|100)\s*%/);
    if (standaloneMatch) {
      const val = parseInt(standaloneMatch[1], 10);
      if (val === 100 && /(?:funktion|funktionsfähig|i\.o|in ordnung|original|echt)/i.test(text)) {
        // Skip generic 100% functional claim
      } else if (!text.includes("rabatt") && !text.includes("nachlass") && !text.includes("gespart")) {
        return val;
      }
    }

    return null; // Unknown battery health -> requires inquiry or image OCR
  }

  /**
   * Determine pricing, offer strategy, and Telegram alerts for a parsed listing.
   */
  static evaluateDeal(parsedListing) {
    if (!parsedListing.qualified) {
      return { action: "IGNORE", reason: parsedListing.rejectReason };
    }

    // Special Alert Rule: M Pro or M Max chip listed < 1000€
    if (parsedListing.isMProOrMax && parsedListing.price < 1000) {
      return {
        action: "TELEGRAM_ALERT_MPRO",
        reason: "MacBook with M Pro / M Max chip listed under 1000€!",
        parsed: parsedListing
      };
    }

    // Critical Rule: If ANY required specification or battery health is missing,
    // inquire about all missing details first WITHOUT any price negotiation.
    if (parsedListing.missingSpecs && parsedListing.missingSpecs.length > 0) {
      return {
        action: "INQUIRE_MISSING_SPECS",
        missingSpecs: parsedListing.missingSpecs,
        reason: `Missing specs to clarify first: ${parsedListing.missingSpecs.join(", ")}`,
        parsed: parsedListing
      };
    }

    const { modelType, chipGeneration, ram, ssd, price, batteryHealth } = parsedListing;
    const rules = this.getPriceRules();
    const modelGroup = rules[modelType]?.[chipGeneration];
    if (!modelGroup) {
      return { action: "IGNORE", reason: `No pricing rules for ${modelType} ${chipGeneration}` };
    }

    // Determine config key: 256_8, 256_16, 512_8, 512_16
    let key;
    if (ssd <= 256 && ram <= 8) key = "256_8";
    else if (ssd <= 256 && ram >= 16) key = "256_16";
    else if (ssd >= 512 && ram <= 8) key = "512_8";
    else key = "512_16";

    const rule = modelGroup[key];
    if (!rule) {
      return { action: "IGNORE", reason: `No specific rule for ${modelType} ${chipGeneration} ${key}` };
    }

    // Check if configuration condition is met (e.g. M5 512_16 condition)
    if (rule.condition && !rule.condition(price)) {
      return { action: "IGNORE", reason: rule.skipReason || "Listing price does not meet entry threshold" };
    }

    // Calculate initial offer price
    const initialOffer = rule.dynamicOffer ? rule.dynamicOffer(price) : rule.offer;
    const maxOffer = typeof rule.max === "function" ? rule.max(price) : rule.max;

    // Check if battery health is known
    const needsBatteryInquiry = batteryHealth === null;

    return {
      action: needsBatteryInquiry ? "INQUIRE_BATTERY" : "SEND_OFFER",
      initialOffer,
      maxOffer,
      hasHigherMax: maxOffer > initialOffer,
      fallbackReject: rule.fallbackReject,
      needsBatteryInquiry,
      parsed: parsedListing
    };
  }

  static extractPrice(str) {
    if (typeof str === "number") return str;
    const clean = str.replace(/[^0-9]/g, "");
    return clean ? parseInt(clean, 10) : 0;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { RulesEngine, PRICE_RULES, DEFECT_KEYWORDS };
}
