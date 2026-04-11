# Tool Reference

All tools use the prefix `pl_comp_`. This document describes every tool exposed by the Polish Competition MCP server.

---

## Search & Retrieval Tools

### `pl_comp_search_decisions`

Full-text search across UOKiK enforcement decisions (abuse of dominance, cartel, sector inquiries).

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query in Polish or English (e.g., `'pozycja dominujaca'`, `'zmowa cenowa'`, `'cartel'`) |
| `type` | string | No | Filter by decision type: `abuse_of_dominance`, `cartel`, `merger`, `sector_inquiry` |
| `sector` | string | No | Filter by sector ID (e.g., `energy`, `telecommunications`) |
| `outcome` | string | No | Filter by outcome: `prohibited`, `cleared`, `cleared_with_conditions`, `fine` |
| `limit` | number | No | Max results (default: 20, max: 100) |

**Output:** `{ results: Decision[], count: number, _meta: ResponseMeta }`

Each result includes `_citation` metadata for entity linking.

---

### `pl_comp_get_decision`

Get a specific UOKiK enforcement decision by case number.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `case_number` | string | Yes | UOKiK case number (e.g., `'DOK-1/2023'`, `'RWA-3/2022'`, `'RKT-1/2023'`) |

**Output:** Full decision object with `_citation` and `_meta`.

---

### `pl_comp_search_mergers`

Search UOKiK merger control decisions (*koncentracje przedsiębiorstw*).

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query in Polish or English (e.g., `'koncentracja'`, `'przejęcie'`, `'telekomunikacja'`) |
| `sector` | string | No | Filter by sector ID |
| `outcome` | string | No | Filter by outcome: `cleared`, `cleared_phase1`, `cleared_with_conditions`, `prohibited` |
| `limit` | number | No | Max results (default: 20, max: 100) |

**Output:** `{ results: Merger[], count: number, _meta: ResponseMeta }`

Each result includes `_citation` metadata for entity linking.

---

### `pl_comp_get_merger`

Get a specific UOKiK merger control decision by case number.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `case_number` | string | Yes | UOKiK merger case number (e.g., `'DKK-1/2023'`, `'DKK-3/2022'`) |

**Output:** Full merger object with `_citation` and `_meta`.

---

### `pl_comp_list_sectors`

List all sectors with UOKiK enforcement activity.

**Input:** None

**Output:** `{ sectors: Sector[], count: number, _meta: ResponseMeta }`

---

## Meta-Tools

### `pl_comp_about`

Return metadata about this MCP server.

**Input:** None

**Output:**
```json
{
  "name": "polish-competition-mcp",
  "version": "1.0.0",
  "description": "...",
  "data_source": "UOKiK (https://www.uokik.gov.pl/)",
  "coverage": { ... },
  "tools": [ ... ],
  "_meta": { "data_age": "2026-03-23", "server": "...", "version": "..." }
}
```

---

### `pl_comp_list_sources`

List all data sources used by this MCP server with freshness information.

**Input:** None

**Output:** Array of source objects, each with `id`, `name`, `authority`, `url`, `coverage`, `languages`, `update_frequency`, and `data_age`.

---

### `pl_comp_check_data_freshness`

Check whether the corpus is up-to-date.

**Input:** None

**Output:**
```json
{
  "last_ingest": "2026-03-23",
  "is_stale": false,
  "record_counts": {
    "mergers": 2823,
    "decisions": 0
  },
  "notes": "...",
  "_meta": { ... }
}
```

---

## Response Metadata

Every tool response includes a `_meta` block:

```json
{
  "_meta": {
    "data_age": "YYYY-MM-DD",
    "server": "polish-competition-mcp",
    "version": "1.0.0"
  }
}
```

## Citation Metadata

`get_*` and `search_*` tools include `_citation` on each entity:

```json
{
  "_citation": {
    "canonical_ref": "DOK-1/2023",
    "display_text": "DOK-1/2023",
    "lookup": {
      "tool": "pl_comp_get_decision",
      "args": { "case_number": "DOK-1/2023" }
    }
  }
}
```

## Error Responses

Errors include `_meta` and `_error_type`:

```json
{
  "error": "Decision not found: DOK-99/9999",
  "_meta": { "data_age": "...", "server": "...", "version": "..." },
  "_error_type": "not_found"
}
```

Possible `_error_type` values: `not_found`, `validation_error`, `internal_error`, `unknown_tool`.
