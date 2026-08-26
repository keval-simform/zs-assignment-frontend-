# ASSUMPTIONS.md

Two parts, as the brief asks: **Part A** — every data-quality issue found and how it is
handled. **Part B** — every ambiguity resolved and why.

Every count is **measured from the data**, not inferred by re-implementing the generator's
index rules — that distinction costs 23% of the affected rows on one defect (§A5).
`npm run forensics` prints the full census; `src/domain/forensics.test.ts` fails if any
number below goes stale. Architecture: **[README.md](./README.md)**.

---

## Part A — Data-quality issues in `generateRows(42, 50000)`

Detection is always by **value** — `typeof calls === 'string'`, `parsed > 60`, `trx === 0` —
never by the generator's index rule, so a differently-seeded defect is still caught.

| Defect | Measured (seed 42) | Rendering | Sorting | Aggregation |
|---|---|---|---|---|
| **A1** Duplicate `id` | 5 ids × 2 rows: `HCP-009973` @ [9972, 9973], then 019946, 029919, 039892, 049865 — always adjacent pairs | Both members flagged → ⚠. Neither hidden nor merged: two real HCPs whose upstream ids collided | Colliding pair lands adjacent; the ascending row-index tiebreak fixes their order | No effect — keyed on group, each row counted once |
| **A2** `specialty === null` | 515 | Em dash `—`. Never `"null"`, never a blank that reads as a layout bug | **Last in both directions** (§B4) | Not a measure |
| **A3** `calls` typed `string` | 236, **all parsable** | The parsed number — string-ness is a transport artefact, not information about the HCP | Numerically: `parseCalls` runs once at load into a `Float64Array`, so the comparator never sees a string (lexically `'40' < '9'`) | At the parsed value |
| **A4** `calls` above the cap of 60 | 4 rows, all 99999, at 12007 / 24014 / 36021 / 48028. Range 0…99999; **excluding these four, 0…40** | Shown untouched, flagged as an outlier. Not clamped, not hidden | Numerically, so they sort to the extreme — correct and informative | Included. A territory holding one is genuinely skewed and the header should say so (§A4b) |
| **A5** `trx === 0` | **112** = 86 seeded + **26 natural** | Row CPI is `null` → `—` | Null CPI last in both directions (§B4) | The row's `calls` still count toward Σ Calls; its `trx` contributes 0 to Σ TRx (§B7) |

**A1 is decisive for identity.** Five ids address two rows each, so `record.id` cannot key
edits, selection, or undo — this is the origin of `RowKey` (§B1). `editLifecycle.test.ts`
edits row 9973 and asserts row 9972, which carries the same id, is untouched.

**A3, stated honestly.** All 236 string values parse. The `null` return from `parseCalls` and
the `UnparsableCalls` flag are a **defensive branch this seed never exercises** —
`naturalModes.test.ts` asserts the unparsable count is exactly 0. They exist because the
`number | string` union permits a non-numeric string and the aggregate must have a defined
answer if one arrives. Claiming they fire on real data would overstate what the code has
actually been exposed to.

**A4, consequence.** These four rows **already violate** the cap the validator enforces:
seeded data is invalid but grandfathered, so we display it and any edit to those cells will
legitimately reject. And because normal `calls` top out at 40, a "+10%" bulk action can never
breach 60 on a normal row — only on these four.

### A4b. The four outliers distort group KPIs by ~60% at region and ~500% at territory level

Not a defect the brief names — the *consequence* of §A4, found by measuring rather than
reading, and the most consequential thing the census turned up. A single 99999 is ~5,000× a
normal `calls` value, so it dominates a sum of ~1,000 rows. The four land in four *different*
regions: Midwest, Southeast, Southwest and West report CPI **7.05–7.11** while the two clean
regions report **4.40** and **4.48** — a ~60% spread that reads as regional performance and is
one row each. Per territory the four affected report **25.40–27.53** against a clean ~4.5:
**+469% to +523%**.

**Decision: do not clamp, exclude, or winsorise** — the distortion is real, and the header
number is the correct sum of the data we were given. Surface it instead: the outlier badge
belongs on the **group header** as well as the row. Silently excluding outliers would make Σ
Calls disagree with the sum of the visible Calls column *and* hide a problem a field team
needs to escalate upstream. This is the strongest available argument for why aggregation
semantics had to be decided deliberately rather than inherited from a grid library's defaults.

### A5. Why `trx === 0` is the trap in this dataset

`trx = Math.round(rand() * 900)` returns 0 whenever `rand() < 1/1800`; over 50,000 rows the
expected count is ~27.8 and **26** occur. The seeded `i % 577` rule explains only **86** of
the 112 affected rows, so a zero-TRx rule derived by reading the generator source misses
**23% of them and leaks `Infinity` into their CPI**. Every zero-TRx test here is therefore
value-based. **Governing principle: index-based rules describe the generator's *intent*;
value-based rules describe the *data*** — they diverge wherever a defect has a natural mode.

### A5b. Natural-mode audit

Verified in both directions by `naturalModes.test.ts`: does the seeded index set explain every
defective row, and does every seeded index actually carry the defect?

| Defect | Natural mode | Why |
|---|---|---|
| `trx === 0` | **YES — 26 rows** | `Math.round(rand() * 900) === 0` when `rand() < 1/1800` |
| `specialty === null` | No | `SPECIALTIES` holds 8 non-null strings, index always in range; only `i % 97` reaches null |
| Duplicate `id` | No | ids are `HCP-` + zero-padded `i + 1`, strictly increasing; only `i % 9973` collides |
| `calls` as string | No | `Math.round()` cannot return a string; only `i % 211` wraps it |
| `calls` unparsable | No — **0 rows** | `String(Math.round(rand() * 40))` and `99999` both parse |
| `calls` above cap 60 | No | natural range is 0–40; only `i % 12007` exceeds it |
| `nrx === 0` | Yes, but harmless | Audited for completeness: legitimate value, divides nothing, needs no handling |

Auditing `nrx` matters — without it the audit would be selective, checking only the fields we
already suspected.

### A6–A8. Structural facts

| Fact | Measured | Decision |
|---|---|---|
| **A6** Names are not identities | 256 distinct names (16 × 16) across 50,000 rows. **Every row shares its name**; the most common repeats 238× | Confirms independently of §A1 that no human-readable field can be identity. Search on name is a **filter**, never a lookup |
| **A7** A region literally named "National" | 1 of 6, with its own 8 territories | An ordinary **peer** region, not a rollup. Special-casing it would double-count every row in it against a total the data never asked for. *Would change my mind:* if its row count equalled the sum of the other five, or its territory names duplicated another region's. Neither is true |
| **A8** `territory` embeds its region (`"<region> / T<n>"`) | 48 territories, 8 per region, 955–1119 rows each (mean 1042) | Keys are **globally unique**, so `T3` in the West cannot collide with `T3` in the Midwest. Display strips the prefix to `T3`, falling back to the full key if the convention changes. Also why sorting is per-territory over ~1,000 rows, not global over 50,000 |

---

## Part B — Ambiguities resolved

Nine decisions carry the architecture and are argued in full; the remaining 27 are one row
each in the tables that follow.

### B1 · What identifies a row for editing, selection, and undo?

**Decision:** the **source array index**, wrapped in a branded `RowKey`. Rejected: `record.id`
(5 ids address 2 rows each, §A1); `name` (256 values for 50,000 rows, §A6); a surrogate uuid
minted at load (unique, but every render needs a 50,000-entry Map lookup to get back to the
row). `FlatIndex`, `RegionIndex` and `TerritoryIndex` are branded separately so the four
"small integer" roles cannot be confused.
**Why:** the only value guaranteed unique, and it makes filter/sort/aggregate index
arithmetic rather than hashing.
**Cost, stated honestly:** an index is not durable across a re-fetch. Rows arriving from a
server need a stable server key, with the index kept only as a local render handle. This
dataset is generated once and never refetched, which is what makes the index safe *here*.
**Would change my mind:** any requirement to refetch, paginate, or persist edits.

### B2 · Where does the pending-vs-committed boundary live?

**Decision:** **two maps** — `committed` (accepted values only) and `cellState` (UI lifecycle
only) — not one map with a status field plus a conditional in the aggregate loop.
**Why:** `computeAggregates` and `applyCallsChange` take `committed` and have **no parameter
through which a pending value could arrive**, so FR-2's exclusion rule is a fact about the
type signature rather than something to remember at every call site. Second benefit: a cell
flipping to pending cannot invalidate the aggregate memo, so nothing recomputes.
**Would change my mind:** a requirement to show optimistic totals — a different product
decision, which would need its own projection rather than a merged map.

### B3 · How are group subtotals stored and kept current?

**Decision:** typed arrays **cloned** on each change — O(1) in rows for the delta, O(groups)
for the clone. `computeAggregates` (full recompute) is kept as the oracle the delta path is
tested against. Region totals roll up from territory totals, never a second row scan.
**Why:** an accepted edit is two array writes plus a 54-number clone instead of a 50,000-row
rescan. All values are integers well below 2^53, so Float64 deltas are exact — five randomised
200-edit runs are asserted equal to a fresh recompute, and a 2,000-delta round trip returns to
exactly zero. Rolling regions up from territories guarantees a region header equals the sum of
its expanded territory headers on screen.
**Why not mutate in place and bump a `version`:** this was the first implementation and it was
wrong. Zustand subscribes via `useSyncExternalStore`, whose contract requires `getSnapshot()`
to return an immutable value. Under mutation, a selector reading an aggregate without *also*
reading the version gets a result that is stale but reference-equal, so it silently skips its
re-render — a header showing the wrong Σ Calls with nothing to signal it. It can also **tear**
under concurrent rendering: a render in progress reads pre-edit values for rows it has passed
and post-edit values for rows it has not. The mutation bought microseconds on an operation
that happens at human speed. **Cost:** ~2 KB per accepted edit, measured as noise.

### B4 · Sorting values that do not compare cleanly *(FR-3 asks for this explicitly)*

**Decision:** nulls **last in both directions** — `specialty === null` (515), undefined CPI
(112), unparsable calls (0 at this seed, implemented anyway). Rejected: nulls-first-on-asc as
a strict mirror; treating null as `0` / `""`.
**Why:** null-as-zero fabricates data — a null CPI is not a CPI of 0. And 515 blank rows is
several screens: under a strict mirror, one click of "descending" buries the data the user
asked to see behind all of them.
**Cost, stated honestly:** descending is not a strict mirror of ascending. Deliberate.
**Would change my mind:** a data-quality workflow whose purpose is *finding* blanks — that
user wants nulls first, and it should be an explicit toggle, not a side effect of direction.

### B7 · Aggregate CPI: ratio of sums, or mean of ratios? *(FR-7 gives only the row formula)*

**Decision:** **ratio of sums**, `Σcalls / Σtrx × 100`.
**Why:** the definitions disagree worst exactly where it matters. A territory of 1,000 HCPs
where one has `calls 1 / trx 1` (CPI 100) and 999 have `calls 10 / trx 100` (CPI 10) has a
mean-of-ratios of 10.09 against a ratio-of-sums of 10.0 — the mean lets one low-volume row
swing a territory-wide number. Ratio of sums is also the only definition that **composes**: a
region's CPI equals the CPI of its combined territories, which is what licenses the O(1) delta
in §B3. Asserted in `cpi.test.ts`.
**Sub-decision:** rows with `trx === 0` are **not excluded** from Σcalls — excluding them would
make a header's Σ Calls disagree with the sum of the visible Calls column, a worse lie than a
marginally optimistic ratio.

### B11 · Do group subtotals follow the search and region filter?

**Decision:** **aggregates ignore the filter; the count reports both.** The header reads
`1,042 HCPs (3 matching)` — the Σ columns describe the territory, the count describes the screen.
**Why:** three reasons, the third decisive. (1) A subtotal is a property of the territory, not
of the query — filter-following subtotals mean the same territory reports different Σ Calls
depending on what is typed, so two screenshots of the same data contradict each other. (2) FR-3
reorders groups by their aggregate on a numeric sort; filter-following aggregates rearrange the
group order on **every keystroke**. (3) It would forfeit the O(1) delta — an accepted edit would
rescan the filtered set instead of adding two integers.
**Cost, stated honestly:** with a search active, Σ Calls does **not** equal the sum of the
visible Calls column. A genuine inconsistency, and `(N matching)` is what makes it legible.
**Would change my mind:** a requirement to answer "what do the rows I'm looking at add up to" —
a *different question*, deserving its own header field rather than redefining this one.

### B16 · What if the user edits a cell whose previous commit is still in flight? *(asked by FR-4)*

**Decision:** **refuse the second edit** until the first settles. The editor will not open,
`commitEdit` returns immediately, no second validator call is made. The control is `disabled`,
so it leaves the tab order rather than looking focusable and swallowing keystrokes.
**Why:** firing both is the dangerous option — with 300–900 ms of jitter, "later result wins"
means the outcome is decided by **latency rather than intent**, and the user's *first* value can
win. Queueing is defensible but builds a per-cell queue with no natural bound, and delays
telling the user that what they are looking at is not editable right now. Refusal is the only
option where the visible state and the truth never disagree.
**Cost:** a mistype waits up to 900 ms to correct. Mitigated by the cell saying why — spinner,
dotted border, `aria-label` "Locked until the server answers".
**Would change my mind:** a validator with cancellation. Then queueing becomes correct: cancel
the in-flight request and fire the new one.

### B21 · Do undo and redo re-validate?

**Decision:** **neither does.**
**Why (undo):** the `before` value was accepted when it was first written; re-asking adds
300–900 ms and a 10% chance of a spurious 503 to an operation whose job is restoring a
known-good state. **Why (redo):** the same, and sharper — at a 10% random failure rate,
re-validating would reject a known-good value roughly **one time in ten**, so a user who undid
and changed their mind would watch their own accepted edit fail with no way to tell the
rejection was noise.
**The condition that makes this safe:** this client is the **only writer**; nothing can change
between the undo and the redo.
**Would change my mind:** a real backend. Then redo must re-validate, each `EditEntry` needs the
row version it was written against, and a rejected redo becomes a conflict the user resolves
rather than a silent drop. Spelled out in README §5.3.

### B27 · Theme validation: allowlist or blocklist?

**Decision:** **allowlist** — each field matched against a pattern of exactly what is
permitted; anything else is discarded and reported.
**Why:** these values reach CSS custom properties, where an unvalidated string is a real
injection vector: `red; background-image: url(https://attacker/p)` terminates the declaration
and injects a second one, from which a config can exfiltrate via a background request, cover
the page with a positioned pseudo-element, or use `content` to misrepresent a control. A
blocklist is the **wrong shape**: CSS has too many equivalent encodings (`\75 rl`, `URL(`,
comment splitting) for "does not contain `url(`" to mean anything. `setProperty` alone is not
sufficient either — it rejects `;` but accepts `red !important`.
**Evidence:** 15 hostile inputs tested; none needed individual anticipation, they fail because
they are not hex.

### The remaining 27 decisions

**Edit lifecycle**

| # | Question | Decision and why |
|---|---|---|
| **B6** | Reject values above the cap before calling the validator? | **No.** `parseCallsInput` validates *form* — a whole non-negative number — never business rules, so `'75'` parses and the validator rejects it. The cap is the server's rule: duplicating it locally bypasses the rejection lifecycle FR-4 exists to exercise and drifts silently the moment the cap changes. A digit-length ceiling *is* enforced, so a pasted 400-digit number cannot reach `Number()` and return `Infinity` |
| **B15** | What does a cell display while pending? | The **committed** value with the proposal beside it — `10 →45`, never in place of it. Showing the proposal alone is an optimistic update, and since aggregates deliberately do not move while pending (§B2) the cell would disagree with its own subtotal for 300–900 ms, with nothing on screen to explain the gap. Showing only the committed value is honest but hides what the user just asked for |
| **B18** | Is a rejection retryable? | **Cap violation: no Retry** — deterministic, the same value fails identically, so a button would be a lie. **503: Retry**, resending the same value. **Unrecognised: retryable**, since refusing a retry on an error we don't understand is the worse mistake. Classification is substring matching on the reason text — brittle *because the contract is*: `validateCalls` rejects with a bare `string`. A real service would return `{ code: 'CALL_CAP' }`. Rejected alternative: inferring "cap" by comparing to 60, which re-implements the server's rule (§B6) |
| **B19** | Where do rejection reasons appear? | **Two places** — on the cell, and in a toast list (`role="log"`, `aria-live="polite"`). 300–900 ms is long enough to scroll, collapse the group, or filter the row away, and a message painted on an unmounted component is a message nobody receives. The cell says *which* value failed; the toast says *that* something failed when you are looking elsewhere. `polite`, not `assertive`: a rejected edit is not an emergency, and assertive cuts across a screen-reader user mid-sentence on every 503 |
| **B20** | Does blur commit, cancel, or neither? | **Neither** — Enter commits, Esc cancels. In a virtualized grid a blur can be the row **unmounting during a scroll**: committing applies an edit never confirmed, cancelling discards typing the user can still see when they scroll back. The draft lives in the store, so scrolling away and back preserves it. **Cost:** diverges from spreadsheet convention, whose failure mode is silent data change |

**Undo and export**

| # | Question | Decision and why |
|---|---|---|
| **B22** | Undo order: LIFO or arbitrary? | **Strict LIFO.** Out-of-order undo lets a stale `before` clobber a newer value: edit 10→20, then 20→30, then undo the *first* command and it writes `before: 10` over a cell holding 30, silently discarding the second edit. LIFO makes that impossible by construction rather than by a merge rule nobody can reason about. **Cost:** undoing one earlier edit means stepping back through everything after it |
| **B23** | Can undo run while an edit is in flight? | **No**, and the refusal is explained in a toast rather than being a silently ignored keystroke. The in-flight request will settle and write `committed`; if undo ran first the two writes would order by **latency rather than intent**, so the visible result would depend on a 300–900 ms coin flip |
| **B24** | Does undo respect the current filter? | **The change is applied regardless.** The view adapts if it can — ancestors expand, the row centres and flashes — and says so plainly when it cannot, offering "Show it". **Undo changes truth, and truth is not filter-dependent**: refusing because the row is off-screen makes correctness depend on the view, and silently clearing the filter is worse — the user typed that search for a reason. "Show it" clears **only** the filters actually in the way (`rowFilterBlock` reports which), since clearing both would discard a region filter they still wanted |
| **B25** | History size | Capped at **100 commands**. Undo is a recovery affordance, not version control — past a hundred steps a user reaches for a filter. The cap matters specifically because one `bulk-edit` command (FR-5) can hold thousands of entries, so an uncapped history is unbounded memory rather than a slowly growing array |
| **B26** | Are pending or rejected edits in the exported change-set? | **No** — built from `committed` only, because the export is "what the server has accepted", the only version of the truth another system should be handed. The "no-op edits deduplicated" bonus needed no code: `writeEntries` deletes a key whose target equals the row's source value, so a row edited 10→40→10 has no entry at all. Each entry carries `rowKey` **as well as** `id`, because `id` is not unique (§A1) and a consumer keying on `id` alone would merge two different HCPs' edits. Entries sort by `rowKey`, so two exports of the same state are byte-identical |

**Filtering and grouping**

| # | Question | Decision and why |
|---|---|---|
| **B5** | `localeCompare` or code-unit comparison? | **Code units** over `nameLower` / `idLower`, precomputed once at load. Every string here is ASCII from a fixed vocabulary and `Intl.Collator` is ~10× slower per comparison; lowercasing at load also keeps search off the allocation path, where `.toLowerCase()` in a keystroke handler allocates 50,000 strings per keypress. **Cost, stated honestly:** wrong for accents or non-Latin scripts. The fix is `Intl.Collator` plus a cached sort-key array per column — the same shape as the current code, so the change is local |
| **B8** | `null` or `0` for an undefined measure? | `null` in the domain, `—` in the DOM. Never `NaN`, `Infinity`, `"null"`, or a substituted `0`. A CPI of 0 means "prescribed to but never called" — a real, actionable fact; `null` means "we cannot know". Collapsing them puts fabricated zeros into a column field teams read as a performance signal. `rowCpi`, `groupCpi` and `formatCpi` each carry a redundant `Number.isFinite` guard because they are the last functions before the DOM |
| **B12** | Does a region filter auto-expand groups, or only a search? | **Only a search** (`FilterResult` carries `unfiltered` and `searchActive` separately). They narrow by wildly different factors: a search reduces 50,000 rows to a handful that are useless while collapsed, whereas a region filter reduces six regions to one — ~8,300 rows — and auto-expanding dumps all of them on a user who asked only to narrow the tree. Both still *hide* empty groups, which is a different question from whether to open them. **How found:** a test that filtered to West expected one row and got four |
| **B13** | Are groups with no surviving rows hidden? | Hidden while a filter is active; all groups shown when none is. After a search for one name, showing 6 regions and 48 territories means scrolling past 47 empty headers to reach the match. With no filter, a genuinely empty group is information |
| **B14** | What if a region filter names a region that doesn't exist? | Filters to **nothing**, not everything. Falling back to "no filter" shows all 50,000 rows while the UI claims a filter is applied — a lie about what the user is looking at. Zero rows plus a visible filter chip is self-explanatory |
| **B35** | Is selection filter-dependent? | `selectTerritoryRows` selects **every** row in the territory, not only visible ones. FR-5 applies a mutation to the selection, and a selection that silently changed size when the user typed in the search box would be a trap |
| **B36** | Search input: store-controlled or debounced local state? | Local draft, pushed to the store on a **150 ms** debounce. Binding directly to `view.search` puts the whole derived pipeline between the keypress and the character appearing, so typing feels laggy even though every stage is fast. The filter stage measures ~4.7 ms, so the debounce is about not scheduling eight renders in the time it takes to type "anita" — not about the scan |

**Theming (FR-8)**

| # | Question | Decision and why |
|---|---|---|
| **B28** | Reject or clamp an out-of-range value? | **Colours reject, `radius` clamps (0–24), `appName` truncates (64)** — the distinction is whether intent is legible. `radius: 30` clearly means "very round", honourable at 24; `#ZZ8800` has *unknowable* intent (orange? a paste accident?) and guessing is worse than falling back. `radius: '8'` is a **rejection**, not a parse opportunity: coercing numeric strings today means accepting `'8; content: attack'` tomorrow. 4- and 8-digit alpha hex are valid CSS and **rejected anyway** — a semi-transparent `text` destroys contrast, and the ratio cannot be validated at config time because it depends on what ends up behind it |
| **B29** | What happens on an unknown `?tenant=`? | Falls back to `DEFAULT_THEME` with no error, and **the requested value is discarded** rather than stored or displayed (`ResolvedTheme.unknownTenantRequested` records only that it happened). Echoing an unvalidated query parameter into the DOM is reflected XSS in its most ordinary form; React would escape it, but the value has no business existing past resolution — a test asserts a hostile value appears nowhere in the serialised state or in `document.body.innerHTML`. The issue panel says *that* an unknown tenant was requested, without saying what, because silence would leave a presenter with a URL typo unable to tell why the theme looked wrong. Lookup uses `Object.hasOwn`, not `in`: `'toString' in TENANT_THEMES` is true, and a tenant id of `constructor` must not resolve to a prototype member |
| **B30** | Are edit-state colours themeable? | **No — fixed, outside the theming surface**, plus a non-chromatic signal per state (⟳ ✓ ⚠, dotted vs solid border). Deriving them from the tenant palette is not decidable from the config alone: contrast between five state colours and an arbitrary palette cannot be validated without knowing what ends up behind each one. Fixing them makes FR-8's "clearly distinguishable under every theme" structural, and the glyphs satisfy WCAG 1.4.1 at the same time. **Evidence:** under `meridian`, `--state-pending` is unset on the root and a pending cell still carries its glyph and `disabled` state |
| **B31** | Where is the theme applied? | Six CSS custom properties on `document.documentElement`, written in an effect. Colour is a property of the *document*, not of any component's state, so this repaints the whole app with **zero React re-renders** — inline styles or a theme context would re-render every themed component on a switch. **Not Tailwind:** its model compiles utility classes from a config, a build-time decision; runtime theming there means shipping every tenant's classes or driving Tailwind's colours from CSS variables, at which point the variables do the work and Tailwind is overhead |

**Rendering and toolchain**

| # | Question | Decision and why |
|---|---|---|
| **B32** | Row height and virtualization strategy | Fixed **32 px** rows, hand-rolled windowing, 6 rows of overscan. Uniform heights reduce windowing to two divisions, which is what makes a library unnecessary — measurement caching and dynamic-size estimation are precisely the parts not needed. 50,054 × 32 px ≈ 1.60M px against a ~33.5M px browser cap, ~11× headroom, so no scroll-scaling hack. **Cost, stated honestly:** a long name truncates rather than wraps and a two-line row needs the hook rewritten. Dynamic heights are exactly where a virtualization library earns its place |
| **B33** | React keys for virtualized rows | Row identity — `d:${rowKey}`, `r:${regionKey}`, `t:${territoryKey}` — never the flat-list position. With position keys React recycles component state onto whatever row slides into the slot: an open edit box jumps to a different doctor mid-scroll and a pending spinner follows the viewport instead of its own cell. This is the concrete reason `FlatIndex` is branded separately from `RowKey` |
| **B34** | What does the footer's "rows in DOM" count? | Every row element React rendered — group headers **and** overscan included. The number's job is to substantiate "only visible rows exist in the DOM", so excluding either would overstate how well we are doing. It settles at roughly viewport rows + 2 × overscan (26 at rest, 32 mid-list in a 640 px viewport) and stays there while scrolling 50,000 rows |
| **B37** | Dataset seed and size — configurable? | Fixed at `generateRows(42, 50000)` in `appStore.ts`; the factory accepts any `LoadedData`. The brief states the submission is evaluated against the exact dataset developed on, so the app pins the seed — a URL parameter would invite evaluation against a different dataset than the one every measured number in these documents refers to. Tests exercise other sizes through the factory |
| **B9** | Vendor files verbatim under strict TypeScript | Isolate `src/vendor` in **its own TypeScript project**: `tsconfig.vendor.json` compiles it alone with `noUncheckedIndexedAccess` relaxed and emits declarations, `tsconfig.app.json` sets `disableSourceOfProjectReferenceRedirect` so the app consumes only the emitted contract, and `npm run typecheck` runs `tsc -b` over both. The relaxation is scoped to three files we did not write and is *physically unable* to leak into ours. Rejected: dropping the flag project-wide, which would stop reporting 50,000-row indexing bugs in our own code to accommodate someone else's file; `// @ts-nocheck`, which is a modification |
| **B10** | Discharging `noUncheckedIndexedAccess` on typed-array reads | An explicit check that **throws**, in `src/domain/typed.ts`; full scans that don't need random access use `for..of`, which yields `number` and skips the check. An out-of-range `RowKey` is a programming error — under `?? 0` it becomes a silently wrong subtotal, the single worst failure mode this app has. `!` is banned by the project's own rules and by ESLint. The branch is never taken in correct code, so it predicts perfectly and inlines |
