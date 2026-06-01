# Corpus Coverage

This document describes the completeness and scope of data available through the Polish Competition MCP server.

## Data Sources

### UOKiK Merger Control Decisions (`uokik_mergers`)

| Field | Value |
|-------|-------|
| Source | [BIP UOKiK — Koncentracje](https://uokik.gov.pl/bip/koncentracje) |
| Records | ~2,823 |
| Coverage start | 2004 |
| Coverage end | 2026-03-23 (last ingest) |
| Completeness | High |
| Language | Polish |

**Scope:** All merger control decisions published on the UOKiK Public Information Bulletin (BIP), including:
- Phase I clearances (cleared without conditions)
- Phase II full investigations
- Conditional approvals (cleared with remedies)
- Prohibited mergers

**Known gaps:** Very recent decisions (filed after 2026-03-23) are not yet ingested. Re-run `npm run ingest` or trigger the [Ingest workflow](.github/workflows/ingest.yml) to update.

---

### UOKiK Enforcement Decisions (`uokik_decisions`)

| Field | Value |
|-------|-------|
| Source | [decyzje.uokik.gov.pl](https://decyzje.uokik.gov.pl/) |
| Records | 0 |
| Coverage start | N/A |
| Completeness | **None — not yet ingested** |
| Language | Polish |

**Scope (intended):** Enforcement decisions covering:
- Abuse of dominant position (*nadużywanie pozycji dominującej*)
- Cartel enforcement (*porozumienia ograniczające konkurencję*)
- Sector inquiries (*badania rynku*)
- Consumer protection decisions

**Blocking issue:** The UOKiK antitrust decisions portal uses a legacy Lotus Notes-based document management system. Decisions are accessible as PDFs but structured extraction of case metadata (parties, legal basis, fine amounts, outcome) requires additional engineering work.

**Workaround:** The sample database includes manually curated seed data for testing (`npm run seed`), but production queries against enforcement decisions will return empty results until ingest is implemented.

---

## Sector Coverage

The following sectors are tracked with enforcement activity metadata:

| Sector ID | Name (Polish) | Name (English) |
|-----------|---------------|----------------|
| `energy` | Energetyka | Energy |
| `telecommunications` | Telekomunikacja | Telecommunications |
| `food_retail` | Handel detaliczny żywnością | Food Retail |
| `banking` | Bankowość | Banking |
| `digital_economy` | Gospodarka cyfrowa | Digital Economy |
| `automotive` | Motoryzacja | Automotive |

---

## Update Frequency

The corpus is refreshed via the [weekly ingest workflow](.github/workflows/ingest.yml) (Sundays, 00:00 UTC). Freshness can be checked via the `pl_comp_check_data_freshness` tool or the [check-freshness workflow](.github/workflows/check-freshness.yml).

See [data/coverage.json](data/coverage.json) for machine-readable coverage metadata.
