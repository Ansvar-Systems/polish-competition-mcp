/**
 * Seed the UOKiK database with sample decisions and mergers for testing.
 *
 * Includes representative UOKiK (Urzad Ochrony Konkurencji i Konsumentow)
 * decisions and merger control cases in Polish.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["UOKIK_DB_PATH"] ?? "data/uokik.db";
const force = process.argv.includes("--force");

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

console.log(`Database initialised at ${DB_PATH}`);

interface SectorRow {
  id: string;
  name: string;
  name_en: string;
  description: string;
  decision_count: number;
  merger_count: number;
}

const sectors: SectorRow[] = [
  {
    id: "energy",
    name: "Energia",
    name_en: "Energy",
    description: "Elektroenergetyka, gaz ziemny, energetyka odnawialna, cieplownictwo i handel energia w Polsce. UOKiK jest aktywny w nadzorowaniu liberalizacji rynku energii.",
    decision_count: 2,
    merger_count: 1,
  },
  {
    id: "telecommunications",
    name: "Telekomunikacja",
    name_en: "Telecommunications",
    description: "Komunikacja mobilna, szerokopasmowy internet, telewizja kablowa i satelitarna oraz infrastruktura telekomunikacyjna w Polsce.",
    decision_count: 1,
    merger_count: 2,
  },
  {
    id: "food_retail",
    name: "Handel detaliczny produktami spozywczymi",
    name_en: "Food retail",
    description: "Sieci supermarketow, dyskonty i handel hurtowy produktami spozywczymi w Polsce. Rynek zdominowany przez Biedronke (JM), Lidla, Biedronke i Kaufland.",
    decision_count: 1,
    merger_count: 1,
  },
  {
    id: "banking",
    name: "Bankowosc i uslugi finansowe",
    name_en: "Banking and Financial Services",
    description: "Banki komercyjne, ubezpieczenia, platnosci i infrastruktura rynkow finansowych w Polsce.",
    decision_count: 1,
    merger_count: 1,
  },
  {
    id: "digital_economy",
    name: "Gospodarka cyfrowa",
    name_en: "Digital economy",
    description: "Platformy cyfrowe, handel elektroniczny, media spolecznosciowe i uslugi cyfrowe w Polsce. UOKiK aktywnie bada rynki cyfrowe.",
    decision_count: 2,
    merger_count: 0,
  },
  {
    id: "automotive",
    name: "Motoryzacja",
    name_en: "Automotive",
    description: "Produkcja samochodow, dystrybucja pojazdow, sieci dealerskie i serwisy samochodowe w Polsce.",
    decision_count: 0,
    merger_count: 1,
  },
];

const insertSector = db.prepare(
  "INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const s of sectors) {
  insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
}
console.log(`Inserted ${sectors.length} sectors`);

interface DecisionRow {
  case_number: string;
  title: string;
  date: string;
  type: string;
  sector: string;
  parties: string;
  summary: string;
  full_text: string;
  outcome: string;
  fine_amount: number | null;
  gwb_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    case_number: "DOK-1/2023",
    title: "Google LLC — Naduzywanie pozycji dominujacej na rynku usług reklamowych",
    date: "2023-09-28",
    type: "abuse_of_dominance",
    sector: "digital_economy",
    parties: JSON.stringify(["Google LLC", "Google Ireland Limited", "Google Poland Sp. z o.o."]),
    summary: "UOKiK wydal decyzje stwierdzajaca naduzywanie przez Google pozycji dominujacej na rynku reklamy internetowej w Polsce. Google utrudnial wydawcom dostep do alternatywnych sieci reklamowych poprzez praktyki wylacznosci.",
    full_text: "Prezes UOKiK wszczal postepowanie antytrustowei przeciwko Google LLC w zwiazku z podejrzeniem naduzywania pozycji dominujacej na polskim rynku reklamy internetowej. Google posiada silna pozycje dominujaca na rynkach wyszukiwania internetowego, reklamy kontekstowej (Google Ads / AdSense) i reklamy displayowej (Google Ad Manager / DV360).\n\nZidentyfikowane praktyki:\n1. Klauzule wylacznosci — Google wymagal od wydawcow (portali internetowych, blogow) korzystania wylacznie z systemu Google AdSense w zamian za dostep do wynikow wyszukiwania lub specjalnych stawek reklamowych.\n2. Wiazanie produktow — usluga Google Ad Manager bya dostepna na korzystnych warunkach tylko w polaczeniu z innymi uslugami Google, utrudniajac korzystanie z alternatywnych ad server.\n3. Preferowanie wlasnych uslug reklamowych w aukcjach reklamowych.\n\nUOKiK zastosował decyzje zobowiazujaca: Google zobowiazal sie do zaprzestania praktyk wylacznosci, zapewnienia interoperacyjnosci Google Ad Manager z alternatywnymi uslugami reklamowymi oraz do przejrzystosci w aukcjach reklamowych.\n\nKara: 213 mln PLN (ok. 48 mln EUR). Google zlozyl odwolanie do Sadu Ochrony Konkurencji i Konsumentow (SOKiK).",
    outcome: "fine",
    fine_amount: 48_000_000,
    gwb_articles: JSON.stringify(["Art. 9 UOKiK", "Art. 102 TFUE"]),
    status: "appealed",
  },
  {
    case_number: "RWA-3/2022",
    title: "Kartell producent cementu — Zmowa cenowa na rynku cementu",
    date: "2022-06-15",
    type: "cartel",
    sector: "food_retail",
    parties: JSON.stringify(["CRH Polska SA (Cementownia Nieciecza)", "LafargeHolcim Polska SA", "Dyckerhoff Polska Sp. z o.o.", "Cementownia Ozarow SA"]),
    summary: "UOKiK ukaral czterech producentow cementu za uczestnictwo w kartelu cenowym na polskim rynku cementu budowlanego. Kartell trwal okolo 5 lat i obejmowal koordynacje cen i podzialy rynku.",
    full_text: "UOKiK wykryl i ukaral kartell producent cementu dzialajacy na polskim rynku. Postepowanie zostalo wszczete po zlozeniu wniosku leniency przez jednego z uczestnikow.\n\nOpis kartelu:\nCzterech glownych producentow cementu w Polsce koordynowalo ceny sprzedazy do dystrybutorów i duzych odbiorcow budowlanych. Spotkania kartelowe odbywaly sie pod pozorem spotkan branżowych. Uzgadniano:\n- Roczne podwyzki cen cementu workowan i luzem\n- Minimalny poziom cen w ofertach przetargowych\n- Podzial wielkich odbiorcow (deweloperow, firm budowlanych) miedzy uczestnikow\n- Skoordynowane bojkotowanie odbiorow, ktorzy probowali importowac cement\n\nCzas trwania: 2017-2022\n\nKary:\n- LafargeHolcim Polska: 287 mln PLN\n- CRH Polska: 198 mln PLN\n- Dyckerhoff Polska: 156 mln PLN\n- Cementownia Ozarow: 89 mln PLN (leniency - obniżka 30%)\n\nWszystkie decyzje zaskarzone do SOKiK.",
    outcome: "fine",
    fine_amount: 163_000_000,
    gwb_articles: JSON.stringify(["Art. 6 UOKiK", "Art. 101 TFUE"]),
    status: "appealed",
  },
  {
    case_number: "DOK-2/2022",
    title: "Meta Platforms Inc. — Naduzywanie pozycji dominujacej w mediach spolecznosciowych",
    date: "2022-12-20",
    type: "abuse_of_dominance",
    sector: "digital_economy",
    parties: JSON.stringify(["Meta Platforms Inc.", "Facebook Poland Sp. z o.o."]),
    summary: "UOKiK postawil Meta Platforms Inc. zarzuty dotyczace naduzywania pozycji dominujacej przez laczenie danych z Facebooka, Instagrama i WhatsAppa bez adekwatnej zgody uzytkownikow. Sprawa nawiazuje do podobnych dzialan w Niemczech.",
    full_text: "Prezes UOKiK postawil zarzuty Meta Platforms Inc. (dawniej Facebook) w zwiazku z naduzywaniem pozycji dominujacej na rynku mediow spolecznosciowych w Polsce.\n\nZarzuty:\n1. Laczenie danych uzytkownikow — Meta zbiera i laczy dane uzytkownikow z Facebooka, Instagrama i WhatsAppa oraz z zewnetrznych serwisow internetowych bez wyraznie zgody uzytkownikow. UOKiK ocenij, ze narusza to zasady ochrony danych w sferze konkurencji i stanowi naduzywanie pozycji dominujacej.\n2. Warunki dostepu do platformy — Meta uzaleznia dostep do funkcji platformy od akceptacji warunkow zbierania danych, co jest szczegolnie problematyczne gdy alternatywy dla sieci spolecznosciowych sa ograniczone.\n\nOcena rynku:\nFacebook posiada pozycje dominujaca na polskim rynku uslug sieci spolecznosciowych (udzia rynkowy >80%). Sieciowe efekty zewnetrzne tworza bariery wejscia ograniczajace mozliwosc wyboru alternatywnych uslug przez uzytkownikow.\n\nPostepowanie w toku — UOKiK oczekuje na odpowiedz Meta przed wydaniem ostatecznej decyzji.",
    outcome: "prohibited",
    fine_amount: null,
    gwb_articles: JSON.stringify(["Art. 9 UOKiK", "Art. 102 TFUE"]),
    status: "appealed",
  },
  {
    case_number: "RŁO-2/2021",
    title: "PKN Orlen SA — Badanie cen paliw na stacjach benzynowych",
    date: "2021-07-08",
    type: "sector_inquiry",
    sector: "energy",
    parties: JSON.stringify(["PKN Orlen SA", "BP Polska", "Shell Polska Sp. z o.o.", "Lotos Paliwa Sp. z o.o."]),
    summary: "UOKiK przeprowadzil badanie rynku cen paliw na stacjach benzynowych. Stwierdzono asymetryczne dostosowanie cen (szybkie podwyzki, powolne obnizki) i rekomendowano wiekszą przejrzystosc cenowa.",
    full_text: "UOKiK przeprowadzil szczegolowe badanie rynku detalicznego sprzedazy paliw w Polsce. Badanie bylo odpowiedzia na skargi konsumentow i mediow na zachowanie cen na stacjach benzynowych.\n\nWnioski z badania:\n1. Asymetryczna transmisja cen — ceny detaliczne paliw reaguja szybciej na wzrosty cen ropy naftowej i paliw hurtowych niz na ich spadki. Wzrost cen hurtowych jest 'przerzucany' na konsumentow w ciagu 1-2 dni, podczas gdy obnizki zajmuja czesto ponad tydzien.\n2. Oligopolistyczny charakter rynku — cztery glowne sieci stacji paliw kontroluja okolo 60% rynku. Obserwowane zachowania cenowe sa zbiezne z oligopolistycznym rownoleglym zachowaniem.\n3. Regionalne roznice cen — zaobserwowano trwale roznice cen miedzy regionami, niewyjasnione kosztami transportu.\n\nRekomendacje UOKiK:\n- Wprowadzenie systemu monitorowania cen paliw w czasie rzeczywistym (wzorem systemu MTS-K w Niemczech)\n- Zaostrzenie wymagan dotyczacych przejrzystosci cen hurtowych i detalicznych\n- Udostepnienie aplikacji mobilnej do porownywania cen paliw\n\nBadanie nie zaowocowalo wszczeciem postepowania antytrustowego.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: JSON.stringify(["Art. 48 UOKiK (badanie rynku)"]),
    status: "final",
  },
  {
    case_number: "RKT-1/2023",
    title: "Orange Polska SA — Praktyki dyskryminacyjne wobec operatorow MVNO",
    date: "2023-03-30",
    type: "abuse_of_dominance",
    sector: "telecommunications",
    parties: JSON.stringify(["Orange Polska SA"]),
    summary: "UOKiK nakazal Orange Polska zaprzestania dyskryminacyjnych praktyk wobec wirtualnych operatorow sieci mobilnych (MVNO) dzialajacych na infrastrukturze Orange. Orange uzaleznil dostep do sieci od akceptacji niekorzystnych warunkow.",
    full_text: "UOKiK przeprowadzil dochodzenie w sprawie praktyk Orange Polska wobec wirtualnych operatorow sieci mobilnych (MVNO), ktore korzystaja z infrastruktury Orange na podstawie umow o dostep hurtowy.\n\nStwierdzone naruszenia:\n1. Warunki hurtowe dostep — Orange stosowalo nieprzejrzyste i zmienne warunki hurtowego dostepu do sieci, utrudniajac MVNO planowanie biznesowe i inveztycie w jakose uslug.\n2. Klauzule wylacznosci — niektorym MVNO narzucano warunki, ktore de facto wykluczaly mozliwosc korzystania z uslug innego operatora hurtowego.\n3. Dostep do nowych technologii — MVNO zglosily opoznienia w udzieleniu dostepu do uslug 5G w porownaniu z komercjalnymi oddzialnami Orange.\n\nDecyzja:\nPrezes UOKiK nakazal Orange Polska:\n- Zaprzestania stosowania dyskryminacyjnych warunkow wobec MVNO\n- Opublikowania przejrzystej oferty referencyjnej dostepu hurtowego\n- Zapewnienia dostepu do technologii 5G MVNO na warunkach rownowaznych z podmiotami grupy Orange\nKara pieniezna: 89 mln PLN (ok. 20 mln EUR).",
    outcome: "fine",
    fine_amount: 20_000_000,
    gwb_articles: JSON.stringify(["Art. 9 UOKiK"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status);
  }
});
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface MergerRow {
  case_number: string;
  title: string;
  date: string;
  sector: string;
  acquiring_party: string;
  target: string;
  summary: string;
  full_text: string;
  outcome: string;
  turnover: number | null;
}

const mergers: MergerRow[] = [
  {
    case_number: "DKK-1/2023",
    title: "PKN Orlen SA / Polska Press Sp. z o.o. — Koncentracja w sektorze mediow",
    date: "2023-02-22",
    sector: "banking",
    acquiring_party: "PKN Orlen SA",
    target: "Polska Press Sp. z o.o. (siec regionalnych gazet i portali)",
    summary: "UOKiK wyrodzil zgode na przejecie Polska Press przez PKN Orlen z warunkami. Sprawa wywolala znaczna debate o niezaleznosci mediow i pluralizmie. Rzecznik Praw Obywatelskich zaskarzy decyzje do sadu.",
    full_text: "UOKiK oceniaj transakcje przejecia przez PKN Orlen SA (polski koncern naftowy kontrolowany przez panstwowe) sieci regionalnych tytulów prasowych i portali internetowych Polska Press Sp. z o.o. (nalezace wczesniej do Verlagsgruppe Passau).\n\nZakres transakcji:\nPolska Press posiada 20 dziennikow regionalnych, 120 tygodnikow i ok. 500 portali lokalnych. Jest jednym z wiodacych wydawcow mediow lokalnych i regionalnych w Polsce.\n\nAnaliza rynkowa UOKiK:\nUOKiK ocenial transakcje z perspektywy rynkow mediow (prasa regionalna, reklama lokalna). Stwierdzil, ze na plaszczyznie prawa konkurencji transakcja nie prowadzi do stworzenia lub umocnienia pozycji dominujacej na rynkach, na ktorych dzialaja strony, ze wzgledu na brak poziomych powiazal miedzy dzialnoscia Orlenu i Polska Press.\n\nKontrowersje:\nDecyzja UOKiK nie uwzglednia wzgledow zwiazanych z pluralizmem mediow i niezaelznoscia redakcyjna, poniewaz te kwestie wykraczaja poza kompetencje Prezesa UOKiK w sprawach koncentracji. Rzecznik Praw Obywatelskich i organizacje dziennikarskie zaskarzyly decyzje, powolujac sie na brak uwzglednienia interesu publicznego.\n\nSad Najwyzszy nakazal zbadanie sprawy ponownie pod katem pluralizmu mediow.",
    outcome: "cleared_with_conditions",
    turnover: 6_000_000_000,
  },
  {
    case_number: "DKK-3/2022",
    title: "T-Mobile Polska SA / UPC Polska Sp. z o.o. — Koncentracja w telekomunikacji",
    date: "2022-08-10",
    sector: "telecommunications",
    acquiring_party: "T-Mobile Polska SA (Deutsche Telekom Group)",
    target: "UPC Polska Sp. z o.o. (Liberty Global / Magenta Telekom)",
    summary: "UOKiK wyrodzil zgode na przejecie UPC Polska przez T-Mobile z warunkami. Transakcja lacza operatora mobilnego z operatorem kablowym, tworzac platforma konwergentna FMC (Fixed-Mobile Convergence).",
    full_text: "UOKiK przeprowadzil obszerna analize planowanego przejecia przez T-Mobile Polska SA operatora kablowego UPC Polska Sp. z o.o. nalezacego do grupy Liberty Global.\n\nT-Mobile Polska jest trzecim co do wielkosci operatorem sieci mobilnej w Polsce (udzial ~20%). UPC Polska jest wiodacym operatorem telewizji kablowej i internetu stacjonarnego, obslugujecym okolo 1,5 mln klientow.\n\nAnaliza rynkow:\n1. Rynki poziome — T-Mobile i UPC dzialaja na roznych rynkach (mobilny vs kablowy/stacjonarny) z ograniczonymi powiazaniami poziomymi.\n2. Rynki konwergentne — po polaczeniu podmiot oferowalbedy pakiety FMC (telefon, internet, TV, mobilny), konkurujac z Polsatem (Cyfrowy Polsat/Polkomtel) i Orange.\n3. Ryzyka pionowe — czy nowo utworzony podmiot dyskryminowalbedy konkurentow na rynku przylacza internetowego lub treści telewizyjnych.\n\nWarunki UOKiK:\n- Zachowanie neutralnosci sieciowej i niedyskryminacyjnego dostepu do sieci kablowej przez OTT\n- Gwarancja utrzymania ofert niezwiazanych (standalone) przez 5 lat\n- Kontynuacja umow hurtowych z MVNO/ISP na warunkach istniejacych\n\nTransakcja zatwierdzona z tymi warunkami.",
    outcome: "cleared_with_conditions",
    turnover: 3_800_000_000,
  },
  {
    case_number: "DKK-2/2021",
    title: "Stellantis NV / Autoryzowane Sieci Dealerskie — Zmiany umow dystrybucji",
    date: "2021-05-18",
    sector: "automotive",
    acquiring_party: "Stellantis NV (FCA/PSA połączone)",
    target: "Portfolio umow dystrybucyjnych Grupy PSA i FCA w Polsce",
    summary: "UOKiK przeanalizowal polaczenie FCA i PSA (tworzace Stellantis) pod katem wplywu na sieci dealerskie marek Peugeot, Citroen, Opel, Fiat i Alfa Romeo w Polsce. Transakcja nie wymagala dodatkowych warunkow.",
    full_text: "Globalna koncentracja FCA Group (Fiat Chrysler Automobiles) i PSA Group (Peugeot-Citroen), ktora stworzy Stellantis NV, wymagala oceny przez UOKiK w zwiazku z dzialalnoscija stron w Polsce.\n\nOcena polskich rynkow:\nW Polsce obie grupy posiadaly:\n- FCA: marki Fiat, Alfa Romeo, Jeep, Maserati\n- PSA: marki Peugeot, Citroen, Opel, DS\n\nUOKiK przeanalizowal rynki detalicznego i hurtowego handlu samochodami osobowymi oraz rynki napraw serwisowych poszczegolnych marek.\n\nWnioski:\nUOKiK nie stwierdzil naruszen prawa konkurencji. Polaczone udzialy rynkowe marek FCA i PSA w Polsce (ok. 15% razem) nie stwarzaly ryzyka osiagniecia pozycji dominujacej na rynku. Rynki samochodowe sa wysoce konkurencyjne z dziesiatkiami marek rywalizujacych o konsumentow.\n\nTransakcja zaakceptowana w pierwszej fazie bez warunkow.",
    outcome: "cleared_phase1",
    turnover: 12_000_000_000,
  },
];

const insertMerger = db.prepare(`
  INSERT OR IGNORE INTO mergers
    (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMergersAll = db.transaction(() => {
  for (const m of mergers) {
    insertMerger.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover);
  }
});
insertMergersAll();
console.log(`Inserted ${mergers.length} mergers`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sectors:    ${sectorCount}`);
console.log(`  Decisions:  ${decisionCount}`);
console.log(`  Mergers:    ${mergerCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
