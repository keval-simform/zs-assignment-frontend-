# Assumptions

This has two parts, like the brief asked for. Part A lists the data problems I found in the
sample data and what the app does about each one. Part B lists the things the brief left open to
interpretation, and what I decided to do about each of those.

I kept this short on purpose so it's a quick read — I'm happy to talk through any row in more
detail in person. If you want the raw numbers behind any of this, run `npm run forensics`. There's
also a test (`src/domain/forensics.test.ts`) that fails if any number written here ever goes out
of date. For how the app is built, see **[README.md](./README.md)**. For how to run it, see
**[SETUP.md](./SETUP.md)**.

One thing worth knowing up front: every problem below is found by checking the actual value in a
row (for example, is `calls` a string, or is `trx` equal to 0), never by reading the data
generator's code to guess where problems "should" be. That distinction matters — see A5.

---

## Part A — Problems found in the sample data

| # | What's wrong | What the app does about it |
|---|---|---|
| A1 | 5 ids are reused, so 10 rows end up sharing an id (e.g. `HCP-009973` shows up on rows 9972 and 9973) | Both rows get a warning icon. Neither is hidden or merged — they're two real people. The app uses a row's position in the list as its identity instead of the id (see B1) |
| A2 | `specialty` is missing (null) on 515 rows | Shown as a dash instead of blank space or the word "null". Sorts to the bottom either way |
| A3 | `calls` is stored as text instead of a number on 236 rows, though every one of them still reads as a valid number | Converted to a real number once when the app loads, so sorting and totals always use the number, never the text |
| A4 | 4 rows have `calls` set to 99999, way past the normal cap of 60 | Shown exactly as-is and flagged as unusual. It still counts toward the totals — it isn't hidden or capped |
| A4b | Because of those same 4 rows, region totals come out about 60% too high, and the worst affected territory is up to 523% too high | Left as the real number rather than smoothed out, so the problem stays visible instead of getting buried |
| A5 | `trx` is 0 on 112 rows. Only 86 of those come from an obvious pattern in the sample data — the other 26 happen just by chance | Row CPI is shown as a dash. Because the check looks at the actual value and not just the known pattern, all 112 rows get caught, not only the 86 |
| A5b | Double-checked whether any of the other data problems could also happen "by chance" the way A5 does | Turns out no — every other problem only shows up exactly where the sample data's pattern puts it. A5 is the one exception |
| A6 | Only 256 different names exist across all 50,000 rows | Confirms a name can't be used as an identity either. Searching by name works, but it can never be used to uniquely pick one row |
| A7 | One of the regions is literally named "National" | Treated the same as any other region, not as some kind of summary of the rest. Its numbers don't line up with a summary anyway |
| A8 | A territory's name already has its region baked in, like `"West / T3"` | The app just shows the short part (`T3`) on screen, but sorts and groups using the full name underneath, since that's what keeps every territory's name unique |

---

## Part B — Things the brief left open, and what I decided

### Cross-cutting (not owned by a single requirement)

| # | Open question | What I decided |
|---|---|---|
| B1 | How do you tell one row apart from another? | By its position in the row list, not its id — 5 ids repeat, and only 256 names exist for 50,000 rows, so neither is safe to use |
| B2 | How do you keep an edit that's still saving separate from one that's already saved? | Two separate places in memory: one holds only saved values, the other just tracks whether a cell is saving, saved, or failed. This way, a saving value can never accidentally get counted |

### FR-1 — Virtualized grid

| # | Open question | What I decided |
|---|---|---|
| B3 | Should every row be the same height, or can it vary? | Every row is a fixed height. The trade-off is that long text gets cut off instead of wrapping to a second line |
| B4 | When React tracks each row on screen, what should it use to tell rows apart? | The row's real identity, never just its position on screen — otherwise scrolling could make an open edit box jump onto the wrong row |
| B5 | What exactly does the footer mean by "rows in DOM"? | Every row actually drawn on screen, including group headers — usually somewhere between 26 and 32 rows, no matter how far you've scrolled |

### FR-2 — Two-level grouping with live subtotals

| # | Open question | What I decided |
|---|---|---|
| B6 | How do the totals at the top of each group stay correct as edits come in? | Instead of recalculating everything, each edit just adjusts the total by the small amount that changed |
| B7 | Should the totals change when you search or filter? | No — a total describes the whole group, not just what's currently on screen. The app shows a separate "3 matching" count instead |
| B8 | Should a group with nothing in it be hidden? | Only while a filter is active. With no filter running, an empty group is still useful information |

### FR-3 — Sorting, search, and filtering

| # | Open question | What I decided |
|---|---|---|
| B9 | Where should a blank or missing value land when you sort a column? | Always at the bottom, whether you're sorting up or down — so it can't end up hiding real data no matter which way you sort |
| B10 | Should filtering by region also expand every group automatically, the way searching does? | No — a region filter can still leave thousands of rows, so opening every group at once would be overwhelming |
| B11 | What if someone filters by a region name that doesn't actually exist? | It shows zero rows, not everything — with a clear indicator that a filter is still active |
| B12 | Does typing in the search box update the results instantly? | It waits a short moment (150 ms) after typing stops, so the app doesn't feel laggy while someone is still typing |

### FR-4 — Async-validated inline editing

| # | Open question | What I decided |
|---|---|---|
| B13 | Should the app reject an over-the-limit value itself, before even asking the server? | No — the app only checks that it's a real number. The actual limit is the server's rule to enforce, not something to copy locally |
| B14 | What should a cell look like while it's still saving? | It shows the old value with the new one right next to it, like `10 →45` — never just the new value on its own |
| B15 | What should happen if someone tries to edit a cell while it's still saving? | The edit is blocked until the first save finishes, so two saves can never race each other and produce an unpredictable result |
| B16 | If an edit gets rejected, should the user be able to try again? | Yes, unless it failed because the value was simply too high — that will always fail the same way again, so retrying wouldn't help |
| B17 | Where should the user see why an edit was rejected? | Both on the cell itself and in a small pop-up message, in case they've already scrolled past the cell by the time it fails |
| B18 | If the user clicks away from a cell they're editing, should that save it or cancel it? | Neither — clicking away might just mean the row scrolled out of view, not that the user wanted to cancel |
| B19 | Should undo or redo double-check the value with the server again? | No, because it was already accepted once before. This is only safe because nothing else can change the data behind the scenes |
| B20 | In what order should undo happen? | Always the most recent change first — anything else risks an old value overwriting a newer one |
| B21 | Can someone undo a change while a different save is still in progress? | No, to avoid the result depending on which one happens to finish first |
| B22 | Does undo still work if the row is currently hidden by a filter? | Yes — the change always goes through, and if the row is visible it's scrolled into view; if not, the app explains why |
| B23 | Is there a limit to how many changes can be undone? | Yes, the last 100. One bulk edit alone can already touch thousands of rows |
| B24 | Should edits that are still saving or were rejected show up in the exported file? | No — only changes the server actually accepted, since that's the only version of the truth worth exporting |

### FR-5 / FR-6 — Bulk edit and undo at scale

| # | Open question | What I decided |
|---|---|---|
| B25 | If you select a whole territory, does the search box affect which rows get selected? | No — selecting a territory grabs every row in it, even the ones the current search is hiding |

### FR-7 — Computed column: CPI

| # | Open question | What I decided |
|---|---|---|
| B26 | For a whole group's CPI, do you average each row's CPI, or add everything up first? | Add everything up first, then divide. It's the only version where a region's number still matches if you add up its territories separately |
| B27 | Should a CPI that can't be calculated show as 0, or as nothing? | As nothing (a dash). A CPI of 0 is a real, meaningful result on its own, so using it to also mean "unknown" would be misleading |

### FR-8 — Runtime white-labelling

| # | Open question | What I decided |
|---|---|---|
| B28 | For checking tenant theme colours, is it safer to block bad values or only allow known-good ones? | Only allow known-good values. Trying to block every bad pattern is much easier to get wrong |
| B29 | If a tenant sends a theme value that's out of range, should it be rejected or just corrected? | Colours are rejected outright, since there's no safe way to guess what was meant. Corner radius is capped instead, since the intent there is obvious. App name is just trimmed to a sensible length |
| B30 | What happens if someone requests a tenant that doesn't exist? | The app quietly falls back to the default look. The bad value is never shown or stored anywhere |
| B31 | Can a tenant's theme change the colours used for saving/rejected/pending states? | No, those stay fixed on purpose, so no theme can accidentally make "pending" invisible |