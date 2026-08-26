# HCP Data Explorer

A grid (like a spreadsheet) that shows 50,000 healthcare-provider (HCP) records. Rows are grouped
by region and territory. Only the rows you can actually see on screen get drawn — that's what
"virtualized" means, and it's why the app stays fast with 50,000 rows. You can sort, search,
filter, edit cells, and undo. When you edit a cell, the new value is checked by a validator that
runs in the background and takes a moment to respond ("async" just means "not instant"). Built
with React 18, TypeScript and Vite. Everything runs in the browser — there is no backend server.

How to install and run it: **[SETUP.md](./SETUP.md)**.
Data problems and every judgement call I had to make: **[ASSUMPTIONS.md](./ASSUMPTIONS.md)**.

| # | Requirement | Status |
|---|---|---|
| FR-1 | Draw only the visible rows out of 50,000 | Built |
| FR-2 | Two levels of grouping with live subtotals | Built |
| FR-3 | Sort, search, filter | Built |
| FR-4 | Inline editing with async validation, undo/redo | Built |
| FR-5 | Bulk edit where some rows fail | Design only (Section 5) |
| FR-6 | Undo at scale | Design only (Section 5) |
| FR-7 | CPI (calls per Rx), per row and per group | Built |
| FR-8 | White-labelling / theming at runtime | Built |

Extra things I built that weren't asked for:

- The scrolling/virtualization logic is written by hand instead of using a library.
- A JSON export of changes that skips edits which didn't actually change anything.
- Tests for tricky timing bugs (the kind where two things race to finish first).
- The footer shows live performance numbers.

---

## 1. Architecture and state model

```
src/
├── vendor/                   # provided, do-not-modify: data-generator.ts, mock-validator.ts,
│                              #   theme-config.ts (TENANT_THEMES / DEFAULT_THEME)
├── domain/                   # plain functions, no React, no app state — identity, normalize,
│                              #   grouping, cpi, aggregate, comparators, exportDiff, forensics
├── services/
│   └── validatorClient.ts    # wraps the vendor validator; passed in, not imported directly,
│                              #   so tests can swap it out
├── store/                    # one shared Zustand store, outside the component tree
│   ├── appStore.ts           #   combines the slices below
│   ├── editSlice.ts          #   committed values + cell status (pending/saved/rejected)
│   ├── historySlice.ts       #   undo/redo command history
│   ├── viewSlice.ts          #   sort, search, filter, group-expansion state
│   ├── themeSlice.ts         #   resolved tenant theme
│   ├── commands.ts           #   single-cell and bulk command shapes
│   └── selectors.ts          #   the grouping / aggregate / sort / filter pipeline
├── features/
│   ├── grid/         # Grid.tsx, useVirtualWindow.ts (hand-rolled), DataRow,
│   │                 #   GroupHeaderRow, CallsCell (the editable cell)
│   ├── toolbar/      # SearchBox, RegionFilter, UndoRedo, ExportDiff
│   ├── theme/        # sanitizeTheme.ts, TenantSwitcher.tsx, ThemeProvider.tsx
│   └── feedback/     # Toasts.tsx, ThemeIssuePanel.tsx
└── app/
    ├── App.tsx, main.tsx   # mounts everything
    └── Footer.tsx          # rows-in-DOM count + timing readout
```

**Four decisions that shaped everything else:**

- **Row identity is array position, not `record.id`** — 5 ids are shared across 10 rows and only
  256 names cover all 50,000 rows, so position is the only safe, unique key (full argument in
  ASSUMPTIONS B1).
- **`committed` and `cellState` are kept separate** — totals only ever read from `committed`, so
  FR-2's "no pending edits in totals" rule is guaranteed by the data structure itself, not by
  remembering to check it (ASSUMPTIONS B2).
- **The app-state store lives outside React** — so a validator answer arriving 900 ms after its
  row has scrolled away and unmounted still has somewhere safe to land.
- **Undo/redo is a command history, not data snapshots** — each edit entry stores both `before`
  and `after`, and a bulk edit is just a list of the same entries, so single and bulk edits undo
  through identical code (see Section 4).

---

## 2. Drawing only the visible rows (virtualization)

**The problem:** putting all 50,000 rows on the page at once would make the browser slow and
laggy.

**The fix:** only ever put about 30 rows on the page — just the ones you can actually see right
now. The other 49,970 rows stay in memory, ready to be shown the moment you scroll to them. This
is called "virtualization," and I built it myself instead of using a ready-made library
(`useVirtualWindow.ts`).

**How it works, step by step:**

| Step | In plain words |
|---|---|
| 1. Fix the row height | Every row is exactly 32 pixels tall, always. So the app never has to measure anything — just simple math |
| 2. Fake a full-size scrollbar | A tall, empty spacer sits in the background so the scrollbar *looks* like it's scrolling through all 50,000 rows, even though almost none of them actually exist on the page |
| 3. Do the math | Simple math figures out which rows should currently be visible, based on how far you've scrolled and how tall your screen is |
| 4. Draw those rows | The app draws the visible rows, plus a few extra just above and below, so you never see a blank flash while scrolling fast |
| 5. Move them smoothly | Moving rows around the screen uses a fast technique (`transform`) that doesn't force the browser to redo the whole page layout — that's what keeps scrolling feeling smooth |

**Three extra tricks keep it smooth:**

- The scroll event doesn't wait around for anything — the browser can just scroll immediately.
- Many scroll updates get bundled into a single screen update, instead of redrawing on every tiny
  scroll movement.
- If the visible rows haven't actually changed, the app skips redrawing entirely.

**The result:** in a normal-sized browser window, only about 26–32 rows ever exist on the page at
once — no matter whether you're at row 1 or row 50,000. The footer at the bottom of the app shows
this number live, so you can see it for yourself.

**One tricky detail:** each row needs a stable "name tag" (React calls this a key) so the app can
tell rows apart. That name tag has to be the row's real identity, not just "whichever slot it's
sitting in right now." Otherwise, while scrolling, an open edit box could suddenly jump onto a
completely different doctor's row by mistake.

---

## 3. Why I wrote the grid by hand, and the other tool choices

Almost every feature a ready-made grid library gives you for free turned out to be something the
spec asks us to change:

| What the spec asks for | What a library does by default |
|---|---|
| Totals ignore unsaved edits (FR-2/FR-4) | Totals use whatever value the cell currently shows |
| Totals ignore the search/filter, but show a separate visible-row count | Totals follow the filter, or aren't offered at all |
| Group CPI is a ratio of sums, not an average of per-row ratios (FR-7) | `avg` across rows, if it's offered at all |
| A validator that can't be cancelled, with protection against outdated answers (FR-4) | Save immediately, no way to track which request is which |
| Undo as a history of actions, one undo step per bulk operation (FR-4/FR-5) | Not provided |
| Groups reorder by their total when you sort a numeric column (FR-3) | Groups keep a fixed order |
| Empty/missing values sort last in both directions | Empty values sort first when ascending, last when descending |

**Why no grid library**

- AG Grid and MUI DataGrid only offer grouping and totals in their paid versions, so the brief
  rules them out.
- TanStack Table was the real alternative I considered. I skipped it because it wants full control
  over grouping and sorting — but here, the grouping never changes, and each territory sorts its
  own small list independently. Using TanStack Table would've meant more work converting data into
  and out of its expected shape than just writing it myself.
- TanStack Virtual mostly exists to remember how tall each row is when rows have different
  heights. Since every row here is a fixed 32 px, there's nothing for it to measure.
- What this cost me: no column resizing, reordering, pinning, or CSV export — features a library
  would have given for free.

**Why Zustand for shared app state**

- When one cell starts saving, only that cell re-renders — not the whole grid.
- The store lives outside React, which matters more here than usual (see Section 1).
- I didn't use a library based on individual "atoms" of state, for one specific reason: saving an
  edit (`commitEdit`) updates five different pieces of state at once (`cellState`, `committed`,
  `aggregates`, `history`, `view.editing`). If those were five separate atoms, they'd update one
  at a time — and something watching the state could catch the moment where the edit is saved but
  its undo-history entry hasn't been added yet. At that exact moment, pressing undo would have
  nothing to undo.

**Why CSS Modules and CSS variables, not Tailwind**

- FR-8 requires being able to re-skin the whole app instantly, without rebuilding it.
- Six calls to `setProperty` do exactly that, and none of it causes React to re-render anything.

---

## 4. Editing and undo (FR-4)

### 4.1 The validator, in short

| Fact | Detail |
|---|---|
| Answer time | 300–900 ms |
| Rejects | any value above 60 |
| Random failure | fails ~10% of the time with a server error (503) |
| Can't be cancelled | once asked, it *will* answer — even if the user has already moved on |

That last row shapes the whole design: a request you've already replaced can still come back and
answer up to 900 ms later, so every step below exists to handle that safely.

### 4.2 The 5 states a cell can be in

```
idle → editing → pending → saved
                     ↘ rejected
```

**1. Idle** — the normal, resting state. Enter or a double-click moves it to *editing*.

**2. Editing** — the cell is open for typing.
- Esc → back to *idle*, nothing happens.
- Enter with an invalid value (not a number) → stays in *editing*, shows an inline error.
- Enter with the same value as before → straight back to *idle*. **Zero** validator calls, **zero**
  history entries — nothing was actually asked of the server.
- Enter with a valid, changed value → moves to *pending*.

**3. Pending** — the value is being checked by the validator, in the background.
- Nothing is saved yet, and totals don't move.
- Each check carries its own id (`reqId`), so if a newer edit replaces this one, the old check's
  answer — accept or reject — is recognized as stale and thrown away when it eventually arrives.

**4. Saved** — the validator accepted the value. It's now saved, the total updates, and the change
is added to undo history.

**5. Rejected** — the validator rejected the value. The cell shows why, and a toast appears too.

### 4.3 Two guards worth calling out

**What if you edit a cell that's still saving?** *(FR-4 asks this directly.)* The new edit is
refused — the input box is disabled so it can't even be clicked. The alternative, queuing the new
edit behind the old one, would build up an invisible backlog the user can't see; letting both go
through at once would mean network speed decides which value wins, instead of the user. Other
options I considered are written up in ASSUMPTIONS B15.

**Why it's safe to drop an outdated answer.** A newer edit can replace an older one while the
older one is still waiting on the validator. When that older answer finally arrives, it's checked
against the current state and thrown away if it's no longer relevant — safely, because nothing was
ever saved while it was pending, so there's no half-finished state to undo.

### 4.4 What the user sees on a pending cell

| Detail | Why |
|---|---|
| Old value shown with new one next to it — `10 →45` | Showing only the new value would make the cell disagree with its own total for up to 900 ms |
| Every state has an icon *and* a colour (⟳ ✓ ⚠) | So a tenant's theme can never make "pending" invisible |
| Rejections shown on the cell *and* in a toast | 300–900 ms is long enough to have scrolled away |
| No Retry button over the cap; Retry button on a 503 | Over-cap always fails the same way; a 503 might succeed on retry |
| Enter saves, Esc cancels, clicking away does neither | Losing focus can just mean the row scrolled out of view |

### 4.5 Undo and redo: how the data is structured

| Piece | Shape | What it means |
|---|---|---|
| `history.past` | list of past actions, most recent last | everything that can be undone |
| `history.future` | list of undone actions | everything that can be redone. Cleared the moment a new edit happens |
| a "command" (one action) | one entry for a single-cell edit, a list of entries for a bulk edit | one user action, no matter how many rows it touched |
| an "entry" | `{ rowKey, before, after }` | one row's value, both before and after the change |
| `committed` | row key → the accepted value | a genuine list of what changed vs. the original data, not a full copy of everything |

Since each entry stores both the old and new value, undo reads `before` and redo reads `after` —
same logic, different field. A bulk edit is just a list of these same entries, so a single-cell
edit and a 4,000-row bulk edit undo through identical code (why FR-5 could stay a design instead
of a rewrite). If an entry's new value equals the row's original value, it's dropped from
`committed` entirely.

| Rule | Why |
|---|---|
| Undo strictly follows last-in-first-out order | Undoing out of order could overwrite a newer value: edit 10→20, then 20→30, undo the *first* — it would wrongly write 10 over a cell holding 30 |
| Rejected and no-op edits never get added to history | Nothing was saved, or nothing changed |
| A new edit clears the redo stack | That redo history belongs to a state that no longer exists |
| Undo is refused if a row in that action is still saving | Otherwise the undo and the save race, and network speed decides the winner |
| History keeps at most 100 actions | One bulk-edit action can already contain thousands of row changes |
| Neither undo nor redo re-checks with the validator | The value was already accepted once — this is only safe because **this app is the only thing writing data** (see Section 5) |

### 4.6 Undo works no matter what's on screen

Undo always applies the change, whatever's currently sorted, filtered, or grouped — because undo
restores the true data, and the true data doesn't depend on what's visible.

- **Row hidden by a filter:** the change still happens, and a toast says so with a "Show it"
  button that clears only the filters blocking that row.
- **Row visible:** its parent groups open, the grid scrolls to it, and it flashes briefly.

---

## 5. Bulk edit and undo at scale (FR-5, FR-6 — design only)

This is a design, not working code — here's the plan, in plain terms.

### FR-5 — bulk edit with partial failure

- The user selects rows one by one, or grabs a whole territory in one click (even rows not
  currently visible).
- An action like "+10% calls" runs on the whole selection. Each row is checked separately and at
  the same time as the others (a few rows at once in the background) — so some succeed and some
  fail independently, on their own schedule.
- Partial failure is expected here, not a bug: the sample data is set up so a real chunk of rows
  (roughly 1 in 10) fail no matter what.
- The app reports back "N applied, M rejected," with reasons — failures are grouped by cause so
  the user isn't shown hundreds of near-identical error messages.

### FR-6 — undo at scale

**The state behind one bulk run:** one "operation" object holding a label, a status, running
counts, and one entry per row (`row → { proposed value, status }`, where status is one of: queued,
in progress, applied, rejected, or skipped).

**How it flows, start to finish:**

1. The operation starts, and the selection is cleared right away so it can't be started twice.
2. Rows are processed a few at a time (not all at once, and not one at a time) — each one is
   re-checked against its *current* value right before sending, in case it changed while waiting.
3. As each answer comes back, it's checked again — if it no longer applies, it's thrown away.
4. When every row has been processed, only the rows that actually succeeded are bundled into
   **one single action** and added to undo history.

**Why that makes it exactly one undo step:** nothing is added to history until the whole operation
finishes, so pressing undo once reverts every successful row together — not one undo per row (which
could mean thousands of undo presses for one bulk action). If every row failed, nothing is added
to history at all.

**The other cases FR-6 asks about:**

- **A changed row is hidden** (inside a closed group, or filtered out): undo still applies the
  change, then opens the group and scrolls the row into view — or, if too many rows changed at
  once, just reports the count instead (e.g. "4,300 rows reverted; 120 hidden by search").
- **Does redo re-check with the server? No** — the values were already validated once. This is
  only safe because this app is the only thing changing the data; a real backend would need redo
  to re-check for conflicts.

**One known limitation:** if the user cancels a bulk edit partway through, what was already
completed can't currently be undone as one step. Small fix, but it needs a decision first — should
a cancelled run still count as one undo step, or none at all?

---

## 6. Theming (FR-8)

**Switching tenants:** a dropdown in the toolbar lets you pick a tenant, and it's also saved in the
web address (`?tenant=meridian`) — so sharing that link opens straight into the right tenant's
look.

**The problem:** tenant configs come from customers, so they can't be trusted. A bad or malicious
value could break the page, or even sneak in harmful code through the colour fields.

**The fix:** only accept values that clearly match an expected format — reject everything else. A
value like `red; background-image: url(...)` could otherwise smuggle in extra, harmful code.
Fifteen different malicious test inputs are all correctly rejected.

| What | Rule | Why |
|---|---|---|
| Colours | Must be a proper 3 or 6-digit hex code, e.g. `#0B5FA5` | Anything else could mean many things or hide bad code — safer to just reject it |
| Corner radius | Must be a number, kept between 0 and 24 | A number outside a sensible range is capped instead of rejected, since the intent is clear |
| App name | Trimmed, can't be blank, capped at 64 characters | Stops a broken layout from a name that's empty or far too long |
| Unknown tenant requested | Falls back to the default look, bad value thrown away | Never show or reuse an unchecked value from the web address |

**If only some fields are bad, only those are replaced** — not the whole theme. For example, one
sample tenant has a broken colour and a broken corner-radius value, but the app still keeps that
tenant's own app name and other working colours. One bad field shouldn't wipe out everything else
that tenant customized.

**The user still finds out.** These issues show up in a small, collapsible panel — not a big
warning banner, since the app keeps working fine either way. But they're never hidden completely:
without that panel, a tenant whose colour got rejected would just see a plain default colour, with
no way to tell whether their setting was wrong, ignored, or never received at all.

---

## 7. Performance

**How speed is measured:** a test file times each part of the app. It only reports the numbers —
it doesn't fail the build if something is slow. A hard pass/fail time limit tends to fail randomly
on a slower computer, which just teaches people to re-run it instead of actually checking what's
wrong.

**Where I made things faster:**

| What | Slow way | Fast way | How much faster |
|---|---|---|---|
| Updating totals after saving an edit | Recalculate everything (3.5 ms) | Just add the small change (0.0025 ms) | ~1,400× faster |
| Sorting when you click a column | Sort all 50,000 rows (37.7 ms) | Sort only the open group (0.5 ms) | 75× faster — closed groups aren't sorted at all |
| Searching as you type | Reformat all the text on every keystroke | Text is already prepared in advance | Nothing extra happens while typing |
| Splitting rows by territory | Build 48 brand-new lists every time you filter | Reuse one shared block of memory instead | Basically free |
| No filter applied | Copy all 50,000 row positions | Reuse the existing list | No extra work |
| Handling scrolling | Redraw the screen for every single scroll event | Combine updates into one per screen refresh, skip if nothing changed | Far fewer redraws |
| Rows actually drawn on screen | All 50,054 | Only 26–32 at a time | ~1,500× fewer |

Loading the data for the first time takes about 63 milliseconds, and that only happens once, when
the app starts.

**Two real problems I found while building this:**

- One part of the app was accidentally recalculating on every single keystroke.
- A reported "loading time" number was showing only about a third of the real time, because its
  clock started too late. I found and fixed this before writing it up here.

**What isn't measured:** exactly how smooth the app looks frame-by-frame in a real browser. We do
know for certain that only the visible rows are ever drawn on screen — that part is directly
tested. But "a smooth 60 frames per second" is a reasonable expectation based on that fact, not a
number measured with a real profiling tool.

---

## 8. Testing

There are 387 tests in total. Every one of them passes, every single time.

**How the tests handle waiting:** normally, saving a value takes some time to hear back (up to
about 1 second), and it can also fail at random. To test this properly, each test can say
"pretend this one save just finished, with this result" — so the test stays in full control of
what happens and when, instead of guessing or waiting.

**What the tests make sure of:**

| Area | What is checked |
|---|---|
| Totals | Totals never change while a value is still saving. Once saved, totals update by the right amount |
| Late answers | If a save finishes late and is no longer needed, it is fully ignored |
| Row safety | Editing one row never changes a different row by mistake |
| Undo | Undo still works correctly no matter how the table is sorted, filtered, or grouped |
| Screen speed | Only the rows on screen exist in the page, even while scrolling through all 50,000 rows |
| Totals math | The fast way of updating totals always matches a full, slow recalculation |
| Theme safety | 15 unsafe theme values are all correctly blocked |
| Bulk undo | Undoing a bulk edit brings back every changed row in one single step |

**Extra check:** I broke the bulk-undo logic on purpose, just to make sure the tests would catch
it — and they did.

**Not tested yet:** the working version of bulk edit (FR-5), testing in a real browser, and moving
between cells using the arrow keys.

---

## 9. What I'd change with more time

| Change | Why |
|---|---|
| Test speed in a real browser | Right now the speed claims are based on reasoning, not an actual measurement. I'm sure about how many rows are on screen, since that part is directly tested — but "smooth 60 fps" is still an educated guess, not a measured fact |
| Allow rows to have different heights | Every row is currently the same fixed height, which is what keeps scrolling simple and fast. But it also means a long name gets cut off instead of wrapping. Supporting different heights would need a bigger rewrite of the scrolling logic |
| Actually build the bulk-edit feature (FR-5) | It's planned in enough detail that building it for real would mostly be simple, mechanical work |
| Break one long function into smaller pieces | One function that saves an edit is fairly long. I'd keep its overall order exactly as-is, but split parts of it into smaller, easier-to-read pieces |
| Use smarter text sorting | Sorting text currently works correctly for plain English, but would sort incorrectly for accented letters or other alphabets. A small fix would handle that properly |

---

## 10. Time spent

Roughly 18–20 hours. The order I did things in mattered more than the total time.

The first stretch of time went into carefully checking the dataset itself before writing any UI at
all. That's where the data-quality report and most of Part A of ASSUMPTIONS.md came from — and
that's what turned up the duplicate ids and the rows with zero transactions that the documented
rule didn't actually explain. Both of those findings changed the design, rather than being patched
around afterward.

Most of the middle of the project went into the data and app-state model, and then the edit
lifecycle (Section 4), which was the single most time-consuming part. The order of the guard steps
took more attempts to get right than anything else in this project, and the "stale rejection"
edge case only became obvious once a test actually caught it failing.

The rest of the time covered the grid itself and its group headers, showing data problems visually,
the toolbar and footer, theming, the FR-5/FR-6 design work, and writing these three documents.
