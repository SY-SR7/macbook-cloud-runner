/**
 * Kleinanzeigen MacBook Deal Hunter - Message Generator & Tone Engine
 * Generates natural, respectful German messages matching the user's exact persona:
 * 1. Battery inquiry only (no price talk).
 * 2. Location-adapted first offer (In Hannover vs Coming from Hannover).
 * 3. Polite deferral when rejected ("Falls der Preis später doch passt...").
 * 4. Maximum budget offer when applicable ("Mehr als X kann ich wirklich nicht zahlen...").
 * 5. Dynamic template overrides when user extracts tone from past chats.
 */

const DEFAULT_TEMPLATES = {
  // Phase 1: Pure battery inquiry (ultra-direct, authentic chat style)
  batteryInquiry: [
    "Hallo,\nBatterie Kapazität?"
  ],

  // Phase 1b: RAM / Storage inquiry
  specsInquiry: [
    "Hallo\nRAM und Speicherplatz?"
  ],

  // Phase 2: First Offer - Seller inside Hannover (authentic student budget + local pickup)
  firstOfferInHannover: [
    "Hallo\nDas Gerät gefällt mir sehr gut, aber ich bin Student und habe ehrlich gesagt ein Budget von {OFFER}€\nIch glaube, das ist nicht ganz einfach, aber wenn es möglich ist, komme ich sehr gerne aus Hannover vorbei und hole es ab"
  ],

  // Phase 2: First Offer - Seller outside Hannover (leveraging travel from Hannover)
  firstOfferOutsideHannover: [
    "Hallo\nDas Gerät gefällt mir sehr gut, aber ich bin Student und habe ehrlich gesagt ein Budget von {OFFER}€\nEhrlich gesagt bin ich in Hannover und hatte vor, zu dir zu kommen, falls mein Budget für dich in Ordnung sind\nmehr kann ich wirklich nicht zahlen"
  ],

  // Phase 3: Polite Deferral when offer rejected (leaving door wide open)
  // Proven psychological winner that turns rejections into next-day acceptances
  politeDeferral: [
    "Ja ich verstehe das, Leider kann ich diesen Preis nicht zahlen\nFalls es später möglich sein sollte, lassen Sie es mich bitte wissen"
  ],

  // Phase 4: Maximum Budget Counter-offer (firm student boundary)
  maxBudgetCounter: [
    "Vielen Dank für Ihr Angebot. Ich benötige das Gerät derzeit für mein Studium, aber meine aktuelle Situation lässt leider nicht mehr als {MAX_OFFER} € zu\nFalls dieser Preis doch noch für Sie machbar wäre, hole ich es sehr gerne zeitnah ab"
  ],

  // Phase 5: Pre-trip due diligence before traveling outside Hannover
  preTripCheck: [
    "Ich möchte nur noch kurz etwas fragen, weil ich eine längere Strecke fahren muss:\nWurde das Gerät schon einmal geöffnet oder repariert? Und gibt es deiner Meinung nach etwas, das gegen den Kauf spricht?\nAnsonsten freue ich mich wirklich sehr, dass ich es bekomme! Vielen Dank auch dafür, dass du meine aktuelle Situation verstehst 😊"
  ]
};

class MessageGenerator {
  constructor(customTemplates = null) {
    this.templates = customTemplates ? { ...DEFAULT_TEMPLATES, ...customTemplates } : { ...DEFAULT_TEMPLATES };
  }

  /**
   * Update active templates with customized/extracted user phrasing.
   */
  updateTemplates(customTemplates) {
    this.templates = { ...this.templates, ...customTemplates };
  }

  /**
   * 1. First contact when ANY required specification or battery is missing.
   * Asks politely for exactly what is missing, with ZERO price negotiation.
   */
  getMissingSpecsInquiryMessage(missingSpecs = []) {
    if (!missingSpecs || missingSpecs.length === 0) {
      return this.getBatteryInquiryMessage();
    }

    const hasBattery = missingSpecs.includes("battery");
    const hasStorage = missingSpecs.includes("ssd") || missingSpecs.includes("ram");
    const hasChip = missingSpecs.includes("chip") || missingSpecs.includes("modelType");

    if (hasBattery && hasStorage) {
      return "Hallo\nBatterie Kapazität und Speicherplatz?";
    }
    if (hasStorage) {
      return "Hallo\nRAM und Speicherplatz?";
    }
    if (hasChip) {
      return "Hallo\nWelcher M-Chip und Modell?";
    }
    return this.getBatteryInquiryMessage();
  }

  /**
   * 1b. First contact when only battery health is unknown.
   */
  getBatteryInquiryMessage() {
    return this.pickTemplate(this.templates.batteryInquiry);
  }

  /**
   * 2. First price offer after battery is confirmed >= 90% (or already known).
   */
  getFirstOfferMessage(offerPrice, isInHannover) {
    const list = isInHannover
      ? this.templates.firstOfferInHannover
      : this.templates.firstOfferOutsideHannover;
    const text = this.pickTemplate(list);
    return text.replace(/{OFFER}/g, `${offerPrice}`);
  }

  /**
   * 3. Polite deferral if seller rejects the offer.
   */
  getPoliteDeferralMessage() {
    return this.pickTemplate(this.templates.politeDeferral);
  }

  /**
   * 4. Maximum budget offer if seller rejected initial offer and device has higher cap.
   */
  getMaxBudgetOfferMessage(maxPrice) {
    const text = this.pickTemplate(this.templates.maxBudgetCounter);
    return text.replace(/{MAX_OFFER}/g, `${maxPrice}`);
  }

  /**
   * 5. Pre-trip check before traveling outside Hannover
   */
  getPreTripCheckMessage() {
    return this.pickTemplate(this.templates.preTripCheck);
  }

  /**
   * 6. Agreement & pickup logistics
   */
  getAgreementMessage(timeStr = "19Uhr") {
    return `Danke ☺️\nAdresse bitte\nAb ${timeStr} kann ich da sein`;
  }

  /**
   * Classify seller response to know which action to take.
   */
  classifySellerResponse(responseText) {
    const text = responseText.toLowerCase().trim();

    // 1. Positive agreement
    const acceptSignals = [
      "können wir machen",
      "passt",
      "ist in ordnung",
      "kannst du abholen",
      "können sie abholen",
      "abholung möglich",
      "einverstanden",
      "abgemacht",
      "geht klar",
      "ja gerne",
      "können wir tun",
      "wäre ok"
    ];
    for (const s of acceptSignals) {
      if (text.includes(s)) return { type: "ACCEPTED" };
    }

    // 2. Clear Rejection
    const rejectSignals = [
      "nein",
      "nein danke",
      "zu wenig",
      "ist mir zu wenig",
      "festpreis",
      "nicht verhandelbar",
      "kein verhandlungsbasis",
      "viel zu gering",
      "lächerlich",
      "unter 600",
      "unter 500",
      "unter 400",
      "unter 700",
      "leider nein",
      "auf keinen fall"
    ];
    for (const s of rejectSignals) {
      if (text.includes(s)) return { type: "REJECTED" };
    }

    // 3. Counter-Offer with a specific number
    const counterMatch = text.match(/(?:für|abgeben|abholen für|unter|schmerzgrenze|letzter preis)[\s\:\=]*(\d{3})\s*€?/i);
    if (counterMatch) {
      const sellerPrice = parseInt(counterMatch[1], 10);
      return { type: "COUNTER_OFFER", price: sellerPrice };
    }

    // 4. Battery info answer (seller answering our battery inquiry)
    const batteryMatch = text.match(/([5-9][0-9]|100)\s*%/);
    if (batteryMatch) {
      return { type: "BATTERY_ANSWER", percentage: parseInt(batteryMatch[1], 10) };
    }

    // 5. Unknown or unexpected response -> Requires human review via Telegram!
    return { type: "UNEXPECTED", raw: responseText };
  }

  pickTemplate(templatesArray) {
    if (!templatesArray || templatesArray.length === 0) return "";
    return templatesArray[0];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MessageGenerator, DEFAULT_TEMPLATES };
}
