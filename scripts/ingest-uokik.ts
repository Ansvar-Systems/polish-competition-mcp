/**
 * Ingestion crawler for the UOKiK (Urzad Ochrony Konkurencji i Konsumentow)
 * Polish Competition MCP server.
 *
 * Scrapes competition enforcement decisions and merger control decisions from
 * uokik.gov.pl and populates the SQLite database.
 *
 * Data sources:
 *   - https://uokik.gov.pl/bip/koncentracje  — merger/concentration decisions
 *     (~148 pages, 10 per page, dating from 2020 onwards)
 *   - https://decyzje.uokik.gov.pl/bp/dec_prez.nsf — antitrust enforcement
 *     decisions (Lotus Notes DB, PDF-heavy — we scrape the BIP listing
 *     and detail pages instead)
 *
 * Individual decision pages on uokik.gov.pl/bip/ expose structured fields:
 *   - Sygnatura sprawy   (case number, e.g. DKK-2.421.16.2026.KSt)
 *   - Data wplywu wniosku (application date)
 *   - Data decyzji        (decision date)
 *   - Numer decyzji       (decision number, e.g. DKK-85/2020)
 *   - Wnioskodawca        (applicant / acquiring party)
 *   - Stan sprawy         (case status)
 *   - Transaction description in body text
 *
 * Usage:
 *   npx tsx scripts/ingest-uokik.ts
 *   npx tsx scripts/ingest-uokik.ts --dry-run
 *   npx tsx scripts/ingest-uokik.ts --resume
 *   npx tsx scripts/ingest-uokik.ts --force
 *   npx tsx scripts/ingest-uokik.ts --max-pages 5
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["UOKIK_DB_PATH"] ?? "data/uokik.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://uokik.gov.pl";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarUOKiKCrawler/1.0 (+https://github.com/Ansvar-Systems/polish-competition-mcp)";

/**
 * Listing categories on uokik.gov.pl/bip/.
 *
 * The concentration (merger) registry is the primary structured data source.
 * It lists ~1480 entries across 148 pages at 10 per page. Each entry links
 * to a detail page with case metadata.
 *
 * Antitrust enforcement decisions (praktyki ograniczajace konkurencje) are
 * not exposed as a structured BIP listing. They live on decyzje.uokik.gov.pl
 * as PDFs inside a Lotus Notes database. We crawl the news/aktualnosci
 * pages tagged with antitrust topics instead.
 */
const LISTING_CATEGORIES = [
  {
    id: "koncentracje",
    path: "/bip/koncentracje",
    maxPages: 150,
    isMerger: true,
  },
] as const;

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxPagesArg = process.argv.find((_, i, a) => a[i - 1] === "--max-pages");
const maxPagesOverride = maxPagesArg ? parseInt(maxPagesArg, 10) : null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  decisionsIngested: number;
  mergersIngested: number;
  errors: string[];
}

interface ParsedDecision {
  case_number: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  fine_amount: number | null;
  legal_basis: string | null;
  status: string;
}

interface ParsedMerger {
  case_number: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiring_party: string | null;
  target: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  turnover: number | null;
}

interface SectorAccumulator {
  [id: string]: {
    name: string;
    name_en: string | null;
    description: string | null;
    decisionCount: number;
    mergerCount: number;
  };
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pl,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    decisionsIngested: 0,
    mergersIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Listing page parsing — discover individual decision URLs
// ---------------------------------------------------------------------------

/**
 * Crawl paginated listing pages to discover decision/merger URLs.
 *
 * UOKiK BIP concentration listing uses `?page=N` pagination. Each page
 * lists ~10 entries. Each entry has a link to its detail page under /bip/.
 */
async function discoverUrlsFromListings(
  category: (typeof LISTING_CATEGORIES)[number],
  maxPages: number,
): Promise<string[]> {
  const urls: string[] = [];
  const effectiveMax = maxPagesOverride
    ? Math.min(maxPagesOverride, maxPages)
    : maxPages;

  console.log(
    `\n  Discovering URLs from ${category.id} (up to ${effectiveMax} pages)...`,
  );

  for (let page = 1; page <= effectiveMax; page++) {
    const listUrl =
      page === 1
        ? `${BASE_URL}${category.path}`
        : `${BASE_URL}${category.path}?page=${page}`;

    if (page % 10 === 1 || page === 1) {
      console.log(
        `    Fetching listing page ${page}/${effectiveMax}... (${urls.length} URLs so far)`,
      );
    }

    const html = await rateLimitedFetch(listUrl);
    if (!html) {
      console.warn(`    [WARN] Could not fetch listing page ${page}`);
      continue;
    }

    const $ = cheerio.load(html);
    let pageUrls = 0;

    // UOKiK BIP listing pages render entries as linked items.
    // Each entry has an <a> tag with href="/bip/<entity-slug>"
    // pointing to the detail page.
    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Match links that point to individual decision pages under /bip/.
      // These follow the pattern /bip/<entity-slug> and are deeper than
      // the category index page /bip/koncentracje.
      // Exclude pagination links, category index, and non-decision links.
      if (
        href.startsWith("/bip/") &&
        !href.startsWith("/bip/koncentracje") &&
        !href.startsWith("/bip/rejestry") &&
        !href.startsWith("/bip/raporty") &&
        !href.startsWith("/bip/ostrzezenia") &&
        !href.startsWith("/bip/wyjasnienia") &&
        !href.startsWith("/bip/zatory") &&
        !href.includes("?page=") &&
        href.length > "/bip/".length + 3
      ) {
        const fullUrl = `${BASE_URL}${href}`;
        if (!urls.includes(fullUrl)) {
          urls.push(fullUrl);
          pageUrls++;
        }
      }
    });

    // If no new URLs found on this page, we have exhausted the listing
    if (pageUrls === 0 && page > 1) {
      console.log(
        `    No new URLs on page ${page} — stopping pagination for ${category.id}`,
      );
      break;
    }
  }

  console.log(`    Discovered ${urls.length} URLs from ${category.id}`);
  return urls;
}

// ---------------------------------------------------------------------------
// Page parsing — extract structured data from individual decision pages
// ---------------------------------------------------------------------------

/**
 * Extract labelled metadata fields from a UOKiK BIP decision page.
 *
 * UOKiK BIP pages present metadata as label-value pairs. Known fields:
 *   - Sygnatura sprawy       (case number)
 *   - Data wplywu wniosku    (application date)
 *   - Data decyzji            (decision date)
 *   - Data publikacji         (publication date)
 *   - Numer decyzji           (decision number)
 *   - Wnioskodawca            (applicant)
 *   - Stan sprawy             (case status)
 */
function extractMetadata(
  $: cheerio.CheerioAPI,
): Record<string, string> {
  const meta: Record<string, string> = {};

  const labelPatterns: Array<{ label: string; keys: string[] }> = [
    { label: "sygnatura", keys: ["sygnatura sprawy", "sygnatura"] },
    { label: "data_wniosku", keys: ["data wpływu wniosku", "data wplywu wniosku", "data wpływu"] },
    { label: "data_decyzji", keys: ["data decyzji"] },
    { label: "data_publikacji", keys: ["data publikacji"] },
    { label: "numer_decyzji", keys: ["numer decyzji"] },
    { label: "wnioskodawca", keys: ["wnioskodawca"] },
    { label: "stan_sprawy", keys: ["stan sprawy"] },
    { label: "przedmiot", keys: ["przedmiot sprawy", "przedmiot"] },
  ];

  // Strategy 1: Definition list (dl/dt/dd) and labelled field patterns
  $("dl dt, .field--label, .field-label, .label, th").each((_i, el) => {
    const rawLabel = $(el).text().trim().replace(/:$/, "").toLowerCase();
    const valueEl =
      $(el).next("dd").length > 0
        ? $(el).next("dd")
        : $(el).next("td").length > 0
          ? $(el).next("td")
          : $(el)
              .next(".field--item, .field-item, .field__item")
              .first();
    if (valueEl.length > 0) {
      for (const { label, keys } of labelPatterns) {
        for (const key of keys) {
          if (rawLabel.includes(key)) {
            meta[label] = valueEl.text().trim();
          }
        }
      }
      // Also store the raw label for debugging
      if (!meta[rawLabel] && valueEl.text().trim()) {
        meta[rawLabel] = valueEl.text().trim();
      }
    }
  });

  // Strategy 2: Look for bold/strong labels followed by text in paragraphs
  $("p, div, li, span").each((_i, el) => {
    const text = $(el).text().trim();
    for (const { label, keys } of labelPatterns) {
      for (const key of keys) {
        const regex = new RegExp(
          `${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s]+(.+)`,
          "i",
        );
        const match = text.match(regex);
        if (match?.[1] && !meta[label]) {
          meta[label] = match[1].trim();
        }
      }
    }
  });

  // Strategy 3: Extract case number from body text via regex
  if (!meta["sygnatura"]) {
    const bodyText = $("main, article, .content, body").text();
    // UOKiK case numbers: DKK-N.NNN.NN.NNNN.XX or DOK-N.NNN.N.NNNN.XX
    // or older format: DKK/N/NNN/NN/NN/XX or DKK-NNN/YYYY
    const casePatterns = [
      /(?:DKK|DOK|RKT|RŁO|RWA|RGD|RBG|RKR|RPZ|RLU|RWR|DDK|DOZIK|DZP)[-/][\d.]+[\w.]*/i,
    ];
    for (const pattern of casePatterns) {
      const match = bodyText.match(pattern);
      if (match) {
        meta["sygnatura"] = match[0];
        break;
      }
    }
  }

  return meta;
}

/** Parse a Polish date string (dd.MM.yyyy) to ISO format (yyyy-MM-dd). */
function parsePolishDate(raw: string): string | null {
  if (!raw) return null;

  // dd.MM.yyyy (most common on UOKiK pages)
  const dotMatch = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Polish textual date: "28 lutego 2020 r." or "7 kwietnia 2020"
  const polishMonths: Record<string, string> = {
    stycznia: "01",
    styczeń: "01",
    lutego: "02",
    luty: "02",
    marca: "03",
    marzec: "03",
    kwietnia: "04",
    kwiecień: "04",
    maja: "05",
    maj: "05",
    czerwca: "06",
    czerwiec: "06",
    lipca: "07",
    lipiec: "07",
    sierpnia: "08",
    sierpień: "08",
    września: "09",
    wrzesień: "09",
    października: "10",
    październik: "10",
    listopada: "11",
    listopad: "11",
    grudnia: "12",
    grudzień: "12",
  };

  const textMatch = raw.match(/(\d{1,2})[\s.]+(\w+)\s+(\d{4})/);
  if (textMatch) {
    const [, day, monthName, year] = textMatch;
    const monthNum = polishMonths[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  // Already ISO: yyyy-MM-dd
  const isoMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }

  return null;
}

/**
 * Extract a fine/penalty amount from Polish text.
 *
 * Handles Polish number formatting (space as thousands separator,
 * comma as decimal separator) and Polish/EU magnitude conventions.
 * Amounts are stored in EUR. PLN amounts are converted at an
 * approximate rate (1 EUR ~ 4.3 PLN) for consistency with the schema.
 */
function extractFineAmount(text: string): number | null {
  const PLN_TO_EUR = 4.3;

  const patterns = [
    // "N mln EUR" / "N mln euro" / "N milionow EUR"
    { regex: /([\d,.\s]+)\s*(?:mln|milion[oó]w|miliony)\s*(?:EUR|euro)/gi, unit: "mln_eur" },
    // "N mld EUR" / "N miliardow EUR"
    { regex: /([\d,.\s]+)\s*(?:mld|miliard[oó]w|miliardy)\s*(?:EUR|euro)/gi, unit: "mld_eur" },
    // "N mln PLN" / "N mln zl" / "N milionow zlotych"
    { regex: /([\d,.\s]+)\s*(?:mln|milion[oó]w|miliony)\s*(?:PLN|zł|zlotych|złotych)/gi, unit: "mln_pln" },
    // "N mld PLN"
    { regex: /([\d,.\s]+)\s*(?:mld|miliard[oó]w|miliardy)\s*(?:PLN|zł|zlotych|złotych)/gi, unit: "mld_pln" },
    // "kara/kare N PLN/zl" or "N PLN/zl kary"
    { regex: /kar[aeęy]\s+(?:w\s+wysokości\s+)?(?:(?:ok(?:oło)?|ponad|blisko)\s+)?([\d\s.]+(?:,\d+)?)\s*(?:PLN|zł|złotych|zlotych)/gi, unit: "pln" },
    // "€ N" or "EUR N" or "N EUR/euro"
    { regex: /(?:€|EUR)\s*([\d\s.]+(?:,\d+)?)/gi, unit: "eur" },
    { regex: /([\d\s.]+(?:,\d+)?)\s*(?:EUR|euro)\b/gi, unit: "eur" },
    // "N PLN" direct
    { regex: /([\d\s.]+(?:,\d+)?)\s*(?:PLN|zł)\b/gi, unit: "pln" },
  ];

  for (const { regex, unit } of patterns) {
    const match = regex.exec(text);
    if (match?.[1]) {
      // Polish uses space/dot as thousands separator, comma as decimal
      let numStr = match[1].trim().replace(/[\s.]/g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (isNaN(val) || val <= 0) continue;

      switch (unit) {
        case "mln_eur":
          return val * 1_000_000;
        case "mld_eur":
          return val * 1_000_000_000;
        case "mln_pln":
          return Math.round((val * 1_000_000) / PLN_TO_EUR);
        case "mld_pln":
          return Math.round((val * 1_000_000_000) / PLN_TO_EUR);
        case "pln":
          if (val > 10_000) return Math.round(val / PLN_TO_EUR);
          break;
        case "eur":
          if (val > 1_000) return val;
          break;
      }
    }
  }

  return null;
}

/**
 * Extract cited Polish competition law articles and EU treaty articles
 * from the decision text.
 */
function extractLegalArticles(text: string): string[] {
  const articles: Set<string> = new Set();
  let m: RegExpExecArray | null;

  // UOKiK Act articles: "Art. 6 UOKiK" / "art. 9 ustawy" / "Art. 6 ust. 1"
  const uokikPattern =
    /Art(?:ykuł)?\.?\s*(\d+)\s*(?:ust\.\s*\d+\s*)?(?:ustawy\s+(?:z\s+dnia\s+)?(?:16|2007)?.*?(?:ochrony?\s+konkurencji|UOKiK)|UOKiK)/gi;
  while ((m = uokikPattern.exec(text)) !== null) {
    articles.add(`Art. ${m[1]} UOKiK`);
  }

  // Standalone "Art. 6" or "Art. 9" near competition law context
  const artPattern =
    /Art(?:ykuł)?\.?\s*(\d{1,3})\s*(?:ust(?:ęp)?\.?\s*\d+)?/gi;
  while ((m = artPattern.exec(text)) !== null) {
    const num = parseInt(m[1]!, 10);
    // Key competition law articles: 6 (agreements), 9 (abuse of dominance),
    // 13-23 (mergers), 26-31 (decisions), 48 (sector inquiries)
    if ([6, 9, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30, 31, 48].includes(num)) {
      articles.add(`Art. ${num} UOKiK`);
    }
  }

  // TFEU / TFUE articles: "Art. 101 TFUE" / "Art. 102 Traktatu"
  const tfuePattern =
    /Art(?:ykuł)?\.?\s*(101|102)\s*(?:TFUE|TFEU|Traktatu|traktatu)/gi;
  while ((m = tfuePattern.exec(text)) !== null) {
    articles.add(`Art. ${m[1]} TFUE`);
  }

  // "Art. 101" / "Art. 102" standalone near EU context
  const euPattern = /Art\.?\s*(101|102)\b/gi;
  while ((m = euPattern.exec(text)) !== null) {
    articles.add(`Art. ${m[1]} TFUE`);
  }

  // Regulation references: "rozporzadzenie 139/2004" (EU merger regulation)
  if (
    /rozporz[aą]dzeni[aeu]\s*(?:Rady\s*)?(?:WE|EWG|UE|nr)?\s*(?:nr\s*)?139\/2004/i.test(
      text,
    )
  ) {
    articles.add("Rozp. 139/2004 (kontrola koncentracji)");
  }

  return [...articles];
}

/**
 * Classify a UOKiK decision based on metadata, title, and content.
 */
function classifyDecisionType(
  title: string,
  bodyText: string,
): {
  type: string | null;
  outcome: string | null;
} {
  const all = `${title} ${bodyText}`.toLowerCase().slice(0, 4000);

  // --- Type classification ---
  let type: string | null = null;

  if (
    all.includes("kartell") ||
    all.includes("zmowa") ||
    all.includes("porozumieni") &&
    (all.includes("ograniczajac") || all.includes("cenow"))
  ) {
    type = "cartel";
  } else if (
    all.includes("naduzywanie pozycji dominujace") ||
    all.includes("naduzycie pozycji dominujace") ||
    all.includes("pozycja dominujaca") ||
    all.includes("abuse of dominan")
  ) {
    type = "abuse_of_dominance";
  } else if (
    all.includes("badanie rynku") ||
    all.includes("badanie sektorowe") ||
    all.includes("sector inquiry") ||
    all.includes("analiza rynku")
  ) {
    type = "sector_inquiry";
  } else if (
    all.includes("praktyki naruszajace zbiorowe interesy konsumentow") ||
    all.includes("nieuczciwe praktyki rynkowe") ||
    all.includes("zbiorowe interesy konsument")
  ) {
    type = "consumer_protection";
  } else if (
    all.includes("przewaga kontraktowa") ||
    all.includes("nieuczciwe wykorzystywanie")
  ) {
    type = "unfair_use_of_advantage";
  } else {
    type = "decision";
  }

  // --- Outcome classification ---
  let outcome: string | null = null;

  if (
    all.includes("kar") &&
    (all.includes("pieniężn") ||
      all.includes("pieniezn") ||
      all.includes("nałoży") ||
      all.includes("nalozy"))
  ) {
    outcome = "fine";
  } else if (
    all.includes("zobowiązan") ||
    all.includes("zobowiazan") ||
    all.includes("warunkami")
  ) {
    outcome = "cleared_with_conditions";
  } else if (
    all.includes("umorzen") || all.includes("umorzeni")
  ) {
    outcome = "closed";
  } else if (
    all.includes("zakaz") ||
    all.includes("zakazał") ||
    all.includes("zakazal")
  ) {
    outcome = "prohibited";
  } else if (
    all.includes("brak naruszen") ||
    all.includes("nie stwierdzono naruszen") ||
    all.includes("nie stwierdzi")
  ) {
    outcome = "cleared";
  }

  return { type, outcome };
}

/**
 * Classify a merger outcome based on page content.
 */
function classifyMergerOutcome(
  title: string,
  bodyText: string,
  status: string | undefined,
): string | null {
  const all = `${title} ${bodyText}`.toLowerCase();

  if (
    all.includes("zakaz koncentracji") ||
    all.includes("zakazal koncentracji") ||
    all.includes("zakazał koncentracji") ||
    all.includes("decyzja zakazujaca")
  ) {
    return "blocked";
  }
  if (
    all.includes("warunkami") ||
    all.includes("warunkowo") ||
    all.includes("zobowiązan") ||
    all.includes("zobowiazan") ||
    all.includes("pod warunkiem")
  ) {
    return "cleared_with_conditions";
  }
  if (
    all.includes("wycofan") ||
    all.includes("cofnięci") ||
    all.includes("cofnieci")
  ) {
    return "withdrawn";
  }

  // Check case status for completed vs pending
  if (status) {
    const lowerStatus = status.toLowerCase();
    if (
      lowerStatus.includes("zakończona") ||
      lowerStatus.includes("zakonczona") ||
      lowerStatus.includes("decyzją") ||
      lowerStatus.includes("decyzja")
    ) {
      // Completed decisions without explicit block/conditions are approvals
      if (
        all.includes("druga faz") ||
        all.includes("drugiej faz") ||
        all.includes("ii faz") ||
        all.includes("phase ii") ||
        all.includes("faza ii")
      ) {
        return "cleared_phase2";
      }
      return "cleared_phase1";
    }
    if (
      lowerStatus.includes("w toku") ||
      lowerStatus.includes("toku")
    ) {
      return null; // Pending — no outcome yet
    }
  }

  // Default: if the page looks like a completed merger, assume phase 1 approval
  return "cleared_phase1";
}

/**
 * Map Polish keywords in title/body to sector IDs.
 */
function classifySector(
  title: string,
  bodyText: string,
): string | null {
  const text = `${title} ${bodyText.slice(0, 3000)}`.toLowerCase();

  const sectorMapping: Array<{ id: string; patterns: string[] }> = [
    {
      id: "digital_economy",
      patterns: [
        "cyfrow",
        "platform",
        "e-commerce",
        "handel elektroniczn",
        "internet",
        "oprogramowan",
        "software",
        "aplikacj",
        "fintech",
        "technologi",
      ],
    },
    {
      id: "food_retail",
      patterns: [
        "spożywcz",
        "spozywcz",
        "żywność",
        "zywnosc",
        "supermarket",
        "dyskont",
        "biedronk",
        "lidl",
        "kaufland",
        "auchan",
        "carrefour",
        "mlecz",
        "mieso",
        "mięs",
        "napoj",
      ],
    },
    {
      id: "energy",
      patterns: [
        "energi",
        "elektroenergetyk",
        "gaz",
        "paliw",
        "benzy",
        "ropa",
        "ciepłowni",
        "cieplowni",
        "odnawialn",
        "fotowoltai",
        "wiatrow",
        "oze",
        "orlen",
        "lotos",
        "pge",
        "tauron",
        "enea",
        "energa",
      ],
    },
    {
      id: "telecommunications",
      patterns: [
        "telekomunikac",
        "mobiln",
        "szerokopasmow",
        "internet",
        "kablow",
        "satelitarn",
        "5g",
        "orange",
        "t-mobile",
        "play",
        "plus",
        "polsat",
        "cyfrowy",
        "upc",
        "mvno",
      ],
    },
    {
      id: "banking",
      patterns: [
        "bank",
        "finansow",
        "ubezpieczen",
        "płatność",
        "platnosc",
        "kredyt",
        "pożyczk",
        "pozyczk",
        "inwestycyjn",
        "fundusz",
        "giełd",
        "gield",
        "maklersk",
      ],
    },
    {
      id: "healthcare",
      patterns: [
        "zdrow",
        "lecznic",
        "szpital",
        "lek",
        "farmaceut",
        "apteczn",
        "medicover",
        "luxmed",
        "enel-med",
        "weterynar",
        "medyczn",
      ],
    },
    {
      id: "automotive",
      patterns: [
        "samocho",
        "motoryzac",
        "dealer",
        "pojazdow",
        "serwis",
        "autom",
        "stellantis",
        "fiat",
        "peugeot",
        "opel",
        "citroen",
        "części zamien",
      ],
    },
    {
      id: "construction",
      patterns: [
        "budowlan",
        "nieruchom",
        "deweloper",
        "cement",
        "beton",
        "stalow",
        "budow",
        "infrastrukt",
        "drog",
      ],
    },
    {
      id: "transport",
      patterns: [
        "transport",
        "logistyk",
        "kolejow",
        "lotniczeg",
        "morsk",
        "spedyc",
        "kuriersk",
        "przewoz",
        "autobus",
      ],
    },
    {
      id: "media",
      patterns: [
        "medi",
        "prasow",
        "wydawni",
        "telewiz",
        "radiow",
        "reklam",
        "gazet",
        "dziennik",
        "portal",
      ],
    },
    {
      id: "retail",
      patterns: [
        "detaliczn",
        "hurtow",
        "handl",
        "dystrybuc",
        "siec handlow",
        "centrum handlow",
      ],
    },
    {
      id: "chemicals",
      patterns: [
        "chemiczn",
        "nawoz",
        "pestycyd",
        "farb",
        "tworzywa sztuczn",
        "polimer",
      ],
    },
    {
      id: "waste_management",
      patterns: [
        "odpad",
        "recykling",
        "gospodark odpadam",
        "śmieciow",
        "smieciow",
        "sortowni",
      ],
    },
  ];

  for (const { id, patterns } of sectorMapping) {
    for (const pattern of patterns) {
      if (text.includes(pattern)) {
        return id;
      }
    }
  }

  return null;
}

/**
 * Parse a UOKiK BIP merger/concentration detail page into a ParsedMerger.
 */
function parseMergerPage(
  html: string,
  url: string,
): ParsedMerger | null {
  const $ = cheerio.load(html);
  const meta = extractMetadata($);

  // Title: page <h1> or <title>
  const pageTitle =
    $("h1").first().text().trim() ||
    $("title").first().text().trim().replace(/ - UOKiK.*$/, "") ||
    "";

  if (!pageTitle) {
    console.warn(`    [WARN] No title found on ${url}`);
    return null;
  }

  // Case number: prefer sygnatura, fall back to numer_decyzji
  const caseNumber =
    meta["sygnatura"] || meta["numer_decyzji"] || "";

  if (!caseNumber) {
    console.warn(`    [WARN] No case number found on ${url}`);
    return null;
  }

  // Date: prefer decision date, fall back to publication date, then application date
  const rawDate =
    meta["data_decyzji"] || meta["data_publikacji"] || meta["data_wniosku"] || "";
  const date = parsePolishDate(rawDate);

  // Status: case status field
  const status = meta["stan_sprawy"] || "";

  // Body text: the main content area
  const mainContent = $("main, article, .content, .node__content").first();
  const bodyText = mainContent.length > 0
    ? mainContent.text().trim()
    : $("body").text().trim();

  // Extract acquiring party and target from the body text
  let acquiringParty: string | null = null;
  let target: string | null = null;

  // The "wnioskodawca" field is the acquiring party
  if (meta["wnioskodawca"]) {
    acquiringParty = meta["wnioskodawca"];
  }

  // Try to extract target from body text
  // Common patterns: "przejęcie kontroli nad X" / "nabycie X"
  const targetPatterns = [
    /przej[eę]ci[eua]\s+(?:przez\s+.+?\s+)?kontroli\s+nad\s+(.+?)(?:\s+z\s+siedzib[aą]|\s*\.|$)/i,
    /naby(?:cie|wając|wajac)\s+(?:\d+%?\s+)?(?:udziałów|udzialow|akcji)\s+(?:w\s+)?(.+?)(?:\s+z\s+siedzib[aą]|\s*\.|$)/i,
    /połączeni[ae]\s+(?:z|ze)\s+(.+?)(?:\s+z\s+siedzib[aą]|\s*\.|$)/i,
    /utworzeni[ae]\s+(?:wspólnego\s+przedsiębiorcy|wspolnego przedsiebiorcy|joint\s+venture)\s+(?:z|ze|przez)\s+(.+?)(?:\s+z\s+siedzib[aą]|\s*\.|$)/i,
  ];

  for (const pattern of targetPatterns) {
    const match = bodyText.match(pattern);
    if (match?.[1]) {
      target = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  // Outcome
  const outcome = classifyMergerOutcome(pageTitle, bodyText, status);

  // Sector
  const sector = classifySector(pageTitle, bodyText);

  // Summary: first substantial paragraph of the body text
  let summary: string | null = null;
  const paragraphs = mainContent.length > 0
    ? mainContent.find("p")
    : $("body p");
  paragraphs.each((_i, el) => {
    if (summary) return;
    const pText = $(el).text().trim();
    if (pText.length > 100) {
      summary = pText.slice(0, 500);
    }
  });

  // Full text: clean body text
  const fullText = bodyText
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!fullText || fullText.length < 50) {
    console.warn(`    [WARN] Body text too short on ${url}`);
    return null;
  }

  return {
    case_number: caseNumber,
    title: pageTitle,
    date,
    sector,
    acquiring_party: acquiringParty,
    target,
    summary,
    full_text: fullText,
    outcome,
    turnover: null, // Not typically published on BIP pages
  };
}

// ---------------------------------------------------------------------------
// Sector management
// ---------------------------------------------------------------------------

/** Sector labels in Polish and English with descriptions. */
const SECTOR_DEFINITIONS: Record<
  string,
  { name: string; name_en: string; description: string }
> = {
  energy: {
    name: "Energia",
    name_en: "Energy",
    description:
      "Elektroenergetyka, gaz ziemny, paliwa, energetyka odnawialna, cieplownictwo i handel energia.",
  },
  telecommunications: {
    name: "Telekomunikacja",
    name_en: "Telecommunications",
    description:
      "Komunikacja mobilna, internet szerokopasmowy, telewizja kablowa i infrastruktura telekomunikacyjna.",
  },
  food_retail: {
    name: "Handel detaliczny produktami spozywczymi",
    name_en: "Food retail",
    description:
      "Sieci supermarketow, dyskonty, handel hurtowy produktami spozywczymi i przemysl spozywczy.",
  },
  banking: {
    name: "Bankowosc i uslugi finansowe",
    name_en: "Banking and Financial Services",
    description:
      "Banki komercyjne, ubezpieczenia, fundusze inwestycyjne, platnosci i infrastruktura rynkow finansowych.",
  },
  digital_economy: {
    name: "Gospodarka cyfrowa",
    name_en: "Digital economy",
    description:
      "Platformy cyfrowe, handel elektroniczny, oprogramowanie i uslugi cyfrowe.",
  },
  automotive: {
    name: "Motoryzacja",
    name_en: "Automotive",
    description:
      "Produkcja samochodow, dystrybucja pojazdow, sieci dealerskie, serwisy i czesci zamienne.",
  },
  healthcare: {
    name: "Ochrona zdrowia",
    name_en: "Healthcare",
    description:
      "Szpitale, kliniki, produkcja i dystrybucja lekow, apteki, uslugi medyczne.",
  },
  construction: {
    name: "Budownictwo",
    name_en: "Construction",
    description:
      "Budownictwo mieszkaniowe i komercyjne, deweloperzy, materialy budowlane, infrastruktura.",
  },
  transport: {
    name: "Transport i logistyka",
    name_en: "Transport and Logistics",
    description:
      "Transport drogowy, kolejowy, lotniczy i morski, logistyka, uslugi spedycyjne.",
  },
  media: {
    name: "Media i reklama",
    name_en: "Media and Advertising",
    description:
      "Prasa, telewizja, radio, wydawnictwa, portale internetowe i reklama.",
  },
  retail: {
    name: "Handel detaliczny i hurtowy",
    name_en: "Retail and Wholesale",
    description:
      "Sieci handlowe, centra handlowe, dystrybucja towarow, e-commerce.",
  },
  chemicals: {
    name: "Chemia i przemysl",
    name_en: "Chemicals and Industry",
    description:
      "Przemysl chemiczny, nawozy, tworzywa sztuczne, przemysl ciezki.",
  },
  waste_management: {
    name: "Gospodarka odpadami",
    name_en: "Waste Management",
    description:
      "Zbieranie, przetwarzanie i recykling odpadow, sortownie, spalanie odpadow.",
  },
};

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function upsertMerger(db: Database.Database, m: ParsedMerger): boolean {
  const existing = db
    .prepare("SELECT id FROM mergers WHERE case_number = ?")
    .get(m.case_number) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE mergers SET
        title = ?, date = ?, sector = ?,
        acquiring_party = ?, target = ?,
        summary = ?, full_text = ?,
        outcome = ?, turnover = ?
      WHERE case_number = ?
    `).run(
      m.title,
      m.date,
      m.sector,
      m.acquiring_party,
      m.target,
      m.summary,
      m.full_text,
      m.outcome,
      m.turnover,
      m.case_number,
    );
    return false; // Updated, not new
  }

  db.prepare(`
    INSERT INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.case_number,
    m.title,
    m.date,
    m.sector,
    m.acquiring_party,
    m.target,
    m.summary,
    m.full_text,
    m.outcome,
    m.turnover,
  );
  return true; // New record
}

function upsertDecision(db: Database.Database, d: ParsedDecision): boolean {
  const existing = db
    .prepare("SELECT id FROM decisions WHERE case_number = ?")
    .get(d.case_number) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE decisions SET
        title = ?, date = ?, type = ?,
        sector = ?, parties = ?,
        summary = ?, full_text = ?,
        outcome = ?, fine_amount = ?,
        gwb_articles = ?, status = ?
      WHERE case_number = ?
    `).run(
      d.title,
      d.date,
      d.type,
      d.sector,
      d.parties,
      d.summary,
      d.full_text,
      d.outcome,
      d.fine_amount,
      d.legal_basis,
      d.status,
      d.case_number,
    );
    return false;
  }

  db.prepare(`
    INSERT INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.case_number,
    d.title,
    d.date,
    d.type,
    d.sector,
    d.parties,
    d.summary,
    d.full_text,
    d.outcome,
    d.fine_amount,
    d.legal_basis,
    d.status,
  );
  return true;
}

function updateSectorCounts(db: Database.Database): void {
  // Clear existing sector data
  db.prepare("DELETE FROM sectors").run();

  // Count decisions and mergers per sector
  const sectorCounts: SectorAccumulator = {};

  const decisionSectors = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector")
    .all() as Array<{ sector: string; cnt: number }>;

  for (const row of decisionSectors) {
    if (!sectorCounts[row.sector]) {
      sectorCounts[row.sector] = {
        name: SECTOR_DEFINITIONS[row.sector]?.name ?? row.sector,
        name_en: SECTOR_DEFINITIONS[row.sector]?.name_en ?? null,
        description: SECTOR_DEFINITIONS[row.sector]?.description ?? null,
        decisionCount: 0,
        mergerCount: 0,
      };
    }
    sectorCounts[row.sector]!.decisionCount = row.cnt;
  }

  const mergerSectors = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector")
    .all() as Array<{ sector: string; cnt: number }>;

  for (const row of mergerSectors) {
    if (!sectorCounts[row.sector]) {
      sectorCounts[row.sector] = {
        name: SECTOR_DEFINITIONS[row.sector]?.name ?? row.sector,
        name_en: SECTOR_DEFINITIONS[row.sector]?.name_en ?? null,
        description: SECTOR_DEFINITIONS[row.sector]?.description ?? null,
        decisionCount: 0,
        mergerCount: 0,
      };
    }
    sectorCounts[row.sector]!.mergerCount = row.cnt;
  }

  const insertSector = db.prepare(
    "INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)",
  );

  for (const [id, data] of Object.entries(sectorCounts)) {
    insertSector.run(
      id,
      data.name,
      data.name_en,
      data.description,
      data.decisionCount,
      data.mergerCount,
    );
  }
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== UOKiK Ingestion Crawler ===");
  console.log(`Database: ${DB_PATH}`);
  console.log(
    `Mode: ${dryRun ? "DRY RUN" : force ? "FORCE (clean DB)" : resume ? "RESUME" : "NORMAL"}`,
  );

  const state = loadState();
  const processedSet = new Set(state.processedUrls);

  let db: Database.Database | null = null;
  if (!dryRun) {
    db = initDb();
  }

  let totalNewMergers = 0;
  let totalUpdatedMergers = 0;
  let totalNewDecisions = 0;
  let totalErrors = 0;

  // -----------------------------------------------------------------------
  // Phase 1: Crawl BIP concentration listings (mergers)
  // -----------------------------------------------------------------------

  for (const category of LISTING_CATEGORIES) {
    const urls = await discoverUrlsFromListings(category, category.maxPages);

    console.log(`\n  Processing ${urls.length} detail pages from ${category.id}...`);

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;

      // Skip already-processed URLs when resuming
      if (resume && processedSet.has(url)) {
        continue;
      }

      if ((i + 1) % 50 === 0 || i === 0) {
        console.log(
          `    Progress: ${i + 1}/${urls.length} (${totalNewMergers} new, ${totalUpdatedMergers} updated, ${totalErrors} errors)`,
        );
      }

      const html = await rateLimitedFetch(url);
      if (!html) {
        totalErrors++;
        state.errors.push(`Failed to fetch: ${url}`);
        continue;
      }

      try {
        if (category.isMerger) {
          const merger = parseMergerPage(html, url);
          if (merger) {
            if (dryRun) {
              console.log(
                `    [DRY RUN] Would insert merger: ${merger.case_number} — ${merger.title.slice(0, 60)}`,
              );
              totalNewMergers++;
            } else {
              const isNew = upsertMerger(db!, merger);
              if (isNew) {
                totalNewMergers++;
              } else {
                totalUpdatedMergers++;
              }
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`    [ERROR] Failed to parse ${url}: ${message}`);
        totalErrors++;
        state.errors.push(`Parse error: ${url} — ${message}`);
      }

      // Track processed URLs for resume
      processedSet.add(url);
      state.processedUrls = [...processedSet];

      // Periodic state saves (every 100 pages)
      if ((i + 1) % 100 === 0) {
        state.mergersIngested = totalNewMergers;
        saveState(state);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: Update sector counts
  // -----------------------------------------------------------------------

  if (!dryRun && db) {
    console.log("\n  Updating sector counts...");
    updateSectorCounts(db);
  }

  // -----------------------------------------------------------------------
  // Final summary
  // -----------------------------------------------------------------------

  state.mergersIngested += totalNewMergers;
  state.decisionsIngested += totalNewDecisions;
  saveState(state);

  if (!dryRun && db) {
    const mergerCount = (
      db.prepare("SELECT count(*) as cnt FROM mergers").get() as {
        cnt: number;
      }
    ).cnt;
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const sectorCount = (
      db.prepare("SELECT count(*) as cnt FROM sectors").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Ingestion Complete ===");
    console.log(`  New mergers:     ${totalNewMergers}`);
    console.log(`  Updated mergers: ${totalUpdatedMergers}`);
    console.log(`  Errors:          ${totalErrors}`);
    console.log(`\n  Database totals:`);
    console.log(`    Mergers:    ${mergerCount}`);
    console.log(`    Decisions:  ${decisionCount}`);
    console.log(`    Sectors:    ${sectorCount}`);

    db.close();
  } else {
    console.log("\n=== Dry Run Complete ===");
    console.log(`  Would insert:    ${totalNewMergers} mergers`);
    console.log(`  Errors:          ${totalErrors}`);
  }

  console.log(`  State saved to: ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
