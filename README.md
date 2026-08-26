# HCP Data Explorer

50,000 healthcare-provider records in a grouped, virtualized, sortable, searchable grid
with async-validated inline editing and command-history undo. React 18 + TypeScript +
Vite. Entirely client-side.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 387 tests
npm run typecheck  # tsc -b, strict + noUncheckedIndexedAccess
npm run lint       # zero any, zero non-null assertions, enforced
npm run forensics  # the measured data-defect census
```

| Requirement | Status |
|---|---|
| FR-1 Virtualized grid · FR-2 Grouping + live subtotals · FR-3 Sort/search/filter | Built |
| FR-4 Async-validated editing + undo/redo · FR-7 CPI · FR-8 White-labelling | Built |
| FR-5 Bulk edit, partial failure · FR-6 Undo at scale | **Design only** (§5) — as the brief allows |

Bonus delivered: hand-rolled virtualization, JSON change-set export with no-op
deduplication, deterministic async-race tests, performance instrumentation.

**[ASSUMPTIONS.md](./ASSUMPTIONS.md)** holds every data-quality defect with its measured
count and handling decision, and every ambiguity resolved — including **sorting semantics
for values that don't compare cleanly** (§B4) and **editing a cell whose commit is still
in flight** (§B16).

---

## 1. The three decisions everything follows from

**1 · Row identity is the source array index, not `record.id`.** The generator duplicates
ids (`i % 9973`): 5 ids spanning 10 rows. Names are worse — 256 distinct combinations
across 50,000 rows, none unique. So identity is the array position, branded so it can't be
confused with a flat-list position:

```ts
declare const RowKeyBrand: unique symbol;
export type RowKey = number & { readonly [RowKeyBrand]: true };
```

Seven such brands exist (`RowKey`, `FlatIndex`, `RegionIndex`, `TerritoryIndex`, `ReqId`,
`OpId`, `CommandId`); their constructors hold the **only seven type assertions in the
codebase**, each runtime-guarded.
Proven by `editLifecycle.test.ts`: edit row 9973, assert row 9972 — same id — is untouched.

*Caveat:* an index isn't durable across a re-fetch. This dataset is generated once from a
fixed seed, which is what makes it safe here. With a real backend the edit map, selection,
and history would key on a server id — a migration, not a rename.

**2 · Two separate maps.**

```ts
readonly committed: ReadonlyMap<RowKey, number>;      // ONLY server-accepted values
readonly cellState: ReadonlyMap<RowKey, CellUiState>; // pending | saved | rejected
```

**Aggregation reads `committed` and nothing else** — `computeAggregates` and
`applyCallsChange` have no parameter through which a pending value could arrive. FR-2's
"aggregates must not include pending edits" is therefore a property of the type signature,
not a conditional someone must remember at every call site. Merged into one map, a cell
flipping to pending would also invalidate the aggregate memo and recompute 50,000 rows to
reach the same answer.

**3 · Every pipeline stage emits indices, never object copies.** The source array is never
sorted or reordered — identity depends on it. Beside it sit projections built once at
load: `callsNum: Float64Array` (parsed once), `trx`/`nrx: Int32Array`,
`nameLower`/`idLower` (lowercased **once**, not per keystroke), a `flags: Uint8Array`
defect bitfield. Filtering and sorting emit `Uint32Array`s of indices; territory buckets
use a CSR layout, so handing out a territory's rows is a zero-copy `subarray`. Sorting is
**per territory** (48 × ~1,042) and only for **expanded** ones. Accepted edits update
aggregates by delta in O(1) — **1,429× cheaper** than a recompute (§6).

---

## 2. Architecture & state model

```
src/vendor/     PROVIDED, VERBATIM, NEVER MODIFIED — separate TS project, so the
                app sees only its .d.ts (see below)
src/domain/     PURE. Zero React, zero store imports. identity · normalize ·
                grouping · cpi · aggregate · comparators · exportDiff · forensics
src/services/   validatorClient — wraps the vendor validator; injected, not imported
src/store/      ONE Zustand store, four slices: view · edit · history · theme
                + commands, selectors (six-stage memoized pipeline)
src/features/   grid/ · toolbar/ · theme/ · feedback/    src/app/  App · Footer · main
```

Everything in `src/domain/` is a pure function of its arguments, which is why 60% of the
suite runs with no DOM. The store holds all mutable state and lives **outside** the
component tree — so a validator result arriving 900 ms after its row unmounted still has
somewhere to land, with no "setState on an unmounted component" problem. **The dependency
rule:** the domain layer never imports from the store; where it needs store-owned data
(the comparator needs *effective* calls, including accepted edits) it takes an accessor as
an argument.

**Vendor files under strict TypeScript.** The provided generator does unchecked indexing,
so it can't compile under `noUncheckedIndexedAccess` — and may not be edited. Resolved
with project references: `tsconfig.vendor.json` covers only `src/vendor` with the flag off
and emits `.d.ts`; `tsconfig.app.json` covers everything else at full rigor. The app
consumes the vendor *contract*, never its source, so the relaxed flag cannot leak.
Dropping the flag project-wide would instead stop reporting indexing bugs in our own
50,000-row loops to accommodate three files we didn't write.

```ts
interface StoreState {
  readonly dataset: Dataset;          // immutable; source array NEVER reordered
  readonly groups: GroupIndex;

  readonly committed: ReadonlyMap<RowKey, number>;      // §1
  readonly cellState: ReadonlyMap<RowKey, CellUiState>; // §1

  readonly aggregates: Aggregates;    // stored, not derived: the O(1) delta needs
                                      // a previous value to add to
  readonly view: ViewState;
  readonly selection: ReadonlySet<RowKey>;   // FR-5 design input
  readonly history: { past: readonly Command[]; future: readonly Command[] };
  readonly theme: ResolvedTheme;
  readonly toasts: readonly Toast[];
  readonly reveal: RevealRequest | null;     // store states intent; grid scrolls
  readonly flashRowKeys: ReadonlySet<RowKey>; // a set, not one key: a colliding
                                              // id pair is only meaningful lit together

  // Monotonic, never reset, never reused — a recycled ticket could let a superseded
  // validator result pass the stale guard.
  readonly nextReqId: ReqId;
  readonly nextCommandId: CommandId;
  readonly lastOp: { label: string; ms: number };
}

type CellUiState =                     // no `idle` member — absence is the fifth state
  | { kind: 'pending';  reqId: ReqId;      proposed: number }
  | { kind: 'saved';    value: number;     at: CommandId }
  | { kind: 'rejected'; attempted: number; reason: RejectionReason };

type RejectionReason =                 // retryability derived from `kind`, not a
  | { kind: 'cap' | 'transient' | 'unknown'; message: string };  // boolean that can drift

interface EditEntry {
  readonly rowKey: RowKey;
  readonly before: number | null;      // null reachable in both directions
  readonly after: number | null;
}

type Command =
  | { kind: 'cell-edit'; id: CommandId; label: string; entry: EditEntry }
  | { kind: 'bulk-edit'; id: CommandId; label: string; opId: OpId;
      entries: readonly EditEntry[] };
```

`bulk-edit` is in the type from the start even though FR-5 is design-only: "one undo step
per bulk operation" is only true if the command shape can hold many entries.

**Expansion is *intent*, not a set of open groups.** FR-3 requires search to auto-expand
matches, so effective expansion has two inputs — user choice and search implication:
`intent.get(key) ?? (searchActive && matched.has(key))`. A single `Set` merges the two, and
clearing the search then destroys the user's own state; two sets break the case where a
user *collapses* a search-expanded group (it writes `true`, the group stays open, the
chevron looks broken). Intent handles all three cases in one line, and `searchExpanded`
stays derived, never stored.

---

## 3. Virtualization & build-vs-buy

Hand-rolled, no library (`useVirtualWindow.ts`). Uniform 32 px rows reduce the problem to
two divisions:

```
first = floor(scrollTop / rowHeight)          start = max(0, first - overscan)
visible = ceil(viewportHeight / rowHeight)    end   = min(count, first + visible + overscan)
```

A spacer of `count * rowHeight` gives the scrollbar its range; rendered rows sit in one
absolutely-positioned layer with `transform: translateY(...)` — a compositor-thread
property, so scrolling never triggers layout, where setting `top` on 40 elements per frame
would invalidate layout 40 times. Three optimisations, each independently necessary and
each tested: a **passive listener** (scrolling isn't blocked on JS); **rAF coalescing**
(20 scroll events → **1** frame scheduled); and a **range bail-out** returning the previous
object reference so React skips the update entirely (5 sub-row scrolls → **0** re-renders).
Measured in a 640 px viewport: **26 rows at rest, 32 mid-list, flat while scrolling
50,000**. The **footer FR-1 asks for** reads those numbers live: rows in DOM out of
50,000, the last store operation with its duration, and each pipeline stage's timing — the
same instrumentation that produced the two findings in §6. React keys are never the
flat-list position — with position keys React recycles component state onto whatever row
slides into the slot, and an open edit box jumps to a different doctor mid-scroll.

**Why hand-rolled.** Every part a grid library gives free is a part the spec then tells us
to override:

| Spec requirement | Library default |
|---|---|
| Aggregates exclude pending edits (FR-2/FR-4) | Aggregates read the cell value, whatever it is |
| Group subtotals ignore the filter, separate visible count | Aggregates follow the filter, or don't exist |
| Aggregate CPI is a ratio of sums, not a mean of ratios (FR-7) | `avg` over rows, if offered |
| Edit lifecycle, non-cancellable validator + stale guard (FR-4) | Optimistic commit, no `reqId` concept |
| Undo as command history, one step per bulk op (FR-4/FR-5) | Not provided |
| Groups reorder by aggregate on numeric sort (FR-3) | Groups keep their own order |
| Nulls last in *both* directions | Nulls first on asc, last on desc |

Overriding all seven means learning the library's extension points, fighting its defaults,
and still writing the semantics — plus shipping its bundle. **AG Grid / MUI DataGrid** gate
grouping and aggregation behind paid tiers, which the brief forbids. **TanStack Table**
(MIT, headless) was the real alternative; I passed because its row model wants to own
grouping and sorting, and this app's grouping index is immutable with per-territory
typed-array sorting — I'd have been adapting index arrays into and out of its shape at
every stage. **TanStack Virtual** likewise: uniform heights are exactly the case where its
value (measurement caching) is the part not needed, leaving nine lines of arithmetic, and
`revealRow` needs to drive `scrollTop` directly. *Where this cost me:* no column resize,
reorder, pinning, or CSV export (§7).

**Zustand**, over Redux Toolkit / Context+useReducer / Jotai. Selector subscriptions mean
one cell going pending re-renders that cell, not the grid (with Context + `useReducer`, a
40-row window with ~5 subscriptions per row is 200 re-renders per keystroke). The store
living outside React is the one that actually matters here. RTK would work but nothing
needs middleware, RTK Query, or Immer. Against Jotai/Recoil: `commitEdit` writes
`cellState`, `committed`, `aggregates`, `history`, and `view.editing` in **one
transition** — across atoms that's several updates a subscriber can observe in between,
including a state where the edit is committed but its history entry isn't pushed yet, at
which point undo has nothing to undo.

**CSS Modules + custom properties, not Tailwind.** FR-8 requires re-skinning at runtime
with no rebuild; six `setProperty` calls on `document.documentElement` repaint the app with
**zero React re-renders**, because colour is a property of the document, not of any
component's state. **Jest + RTL** for the test runner; every meaningful assertion here is
about what a user can perceive, which is what RTL queries for regardless of runner.

---

## 4. Edit lifecycle, concurrency, and undo (FR-4)

The validator settles after 300–900 ms, rejects with a bare **string** when `> 60`, adds
~10% random 503s, and has **no cancellation** — the fact the whole design turns on.

```
   idle ──Enter/dbl──▶ editing ──Esc──▶ idle
  (absent)              │ Enter
                        ├─ parse fails?  ──▶ editing + inline error
                        ├─ no-op?        ──▶ idle (0 validator calls, 0 history)
                        ▼
           pending {reqId, proposed}      committed UNTOUCHED
                        │                 aggregates DO NOT MOVE
                        ├─ settles, reqId stale ──▶ DROPPED ENTIRELY
                        ├─ resolves ──▶ committed.set · O(1) delta · history.push ──▶ saved
                        └─ rejects  ──▶ rejected {attempted, reason} + toast
                                        (committed never written — nothing to revert)
```

**The guard order in `commitEdit` is the design** — each step makes a specific failure
unreachable:

| Step | Guard | What it prevents |
|---|---|---|
| a | **Refuse if the cell is already `pending`** | Two requests racing for one cell, where the **later-settling** one wins regardless of which the user asked for last |
| b | Parse the draft | A typo reaching the network — inline message, no latency cost |
| c | No-op detection | Spending a validator call on an unchanged value, which at a 10% 503 rate would "fail" on something nobody edited. Also gives the no-op-dedup bonus free |
| d | Enter `pending`, **writing nothing to `committed`** | This absence of a write *is* the pending-exclusion mechanism |
| e–f | `await validate`, then the **stale guard on both success and failure paths** | A superseded result clobbering newer state |
| g–h | Accept: write, delta, push history · Reject: reason on the cell **and** a toast | An error nobody sees |

**Step (a) is FR-4's "what if the user edits a cell whose previous commit is still in
flight": the edit is refused and the control is `disabled`** — removed from the tab order
rather than left focusable and swallowing the keystroke. Queueing builds an unbounded chain
the user can't see; firing both lets the later-settling request win by latency rather than
intent. Alternatives in ASSUMPTIONS §B16.

```ts
// The validator cannot be cancelled, so a superseded request still settles — up to
// 900 ms later — and would otherwise clobber whatever the cell holds by then.
if (pendingReqId(get().cellState, rowKey) !== reqId) return;
```

The guard reads `get()` **at settle time**, not a closure-captured value (which would
compare the request to itself), and it's on the **failure path too** — without that, a
superseded *rejection* paints an error over a cell that has since succeeded. Dropping a
stale result is safe *precisely because step (d) wrote nothing*: there is no partial state
to unwind.

**What the user sees.** A pending cell shows the **committed** value with the proposal
beside it — `10 →45`, never `45`; substituting the proposal would be an optimistic update,
and the cell would disagree with its own subtotal for 300–900 ms with nothing on screen to
explain the gap. Every state carries a **non-chromatic** signal as well as colour (⟳ ✓ ⚠,
dotted vs solid border), and state colours sit in a fixed palette deliberately **outside**
the FR-8 theming surface — so a tenant whose primary colour is amber cannot make "pending"
invisible. Rejections surface **twice**, because 300–900 ms is long enough to scroll away:
on the cell, and in a toast (`role="log"`, `aria-live="polite"`). A cap violation is
deterministic and the user's own input, so no retry is offered; a 503 is transient, so
Retry appears. Enter/double-click opens, Enter commits, Esc cancels — **blur does neither**,
because in a virtualized grid a blur can be the row unmounting mid-scroll.

**Undo/redo.** `const target = direction === 'apply' ? entry.after : entry.before;` — that
symmetry is the whole mechanism, and it's what makes FR-5 a *design* rather than a rewrite:
a `bulk-edit` command holding 4,000 entries inverts through the same function. An entry
whose target equals the row's **source** value *deletes* its key from `committed`, keeping
`committed` a true diff — which is what makes the footer's "accepted edits" count honest
and the JSON change-set free of no-op rows.

**Strict LIFO:** only `past.at(-1)` is undoable. Out-of-order undo would let a stale
`before` clobber a newer value — edit 10→20, then 20→30, then undo the *first* command and
it writes `before: 10` over a cell holding 30, silently discarding the second edit.

**Neither undo nor redo re-validates.** The value was accepted once; asking again adds
latency and a 10% chance of a spurious 503 to an operation whose job is restoring a
known-good state. For redo the point is sharper: re-validating would reject a known-good
value roughly one time in ten, so a user who undid and changed their mind would watch their
own accepted edit fail with no way to tell the rejection was noise. **The condition that
makes this safe is specific: this client is the only writer** — see §5.3 for the
multi-writer design.

| Rule | Why |
|---|---|
| Rejected and no-op edits never enter history | Nothing was committed / nothing changed |
| A new edit clears the redo stack | The undone future branched off a state that no longer exists |
| Undo refused while a row in the command is in flight | The in-flight request will settle and write `committed`; if undo ran first, the two writes would order by **latency** rather than **intent** |
| Undo clears the affected rows' badges | "✓ saved" would describe a value that is no longer there |
| History capped at 100 | One `bulk-edit` command can hold thousands of entries |

**Correct regardless of sort, filter, or grouping** — because **undo changes truth, and
truth is not filter-dependent**:

```
undo()
  ├─ invert the command → committed + aggregates                (always)
  ├─ rowFilterBlock(state, rowKey) → 'search' | 'region' | 'both' | null
  ├─ null  → expand ancestors · set reveal {rowKey, nonce} · flash
  │          grid effect: scrollTop = flatIndex * 32 − viewport/2
  └─ blocked → the change STAYS APPLIED
               toast: "Undone: … — the row is hidden by the current search"
               action: "Show it" → clears ONLY the filters in the way, then reveals
```

The store expresses reveal **intent**; the grid performs the scroll. As state, "this row
should be visible" is assertable with no DOM, which is how the sort-then-filter-then-undo
case is tested.

---

## 5. FR-5 / FR-6 DESIGN — bulk edit and undo at scale

**Design deliverables. Not implemented.**

Normal `calls` are `Math.round(rand() * 40)` → range **0–40**; the cap is **60**. A single
"+10%" therefore **cannot** breach the cap on a normal row. Rejections come almost entirely
from the **four 99999 rows** (already over the cap, deterministic) and the **~10% random
503s** — for a 5,000-row selection, roughly **500 expected transient failures**. So the
common case isn't "a few rows failed", it's "hundreds failed for a reason unrelated to the
data" — which is why the summary groups by cause rather than listing 500 identical messages.

### 5.1 State shape

**Selection.** Rows select individually or per territory (FR-5 names both).
`selectTerritoryRows` selects **every** row in the territory, not just the visible ones — a
selection that silently shrank when the user typed in the search box would apply "+10%" to
fewer rows than the checkbox claimed (ASSUMPTIONS §B35). The `selection` set and its actions
are built and tested; only the checkboxes are unrendered (§7). Selection is cleared the
moment an operation starts, so the button can't double-fire.

```ts
export type BulkEntryState =
  | { readonly kind: 'queued' }
  | { readonly kind: 'inflight'; readonly reqId: ReqId }
  | { readonly kind: 'applied';  readonly before: number | null; readonly after: number }
  | { readonly kind: 'rejected'; readonly attempted: number; readonly reason: RejectionReason }
  | { readonly kind: 'skipped';  readonly why: 'superseded' | 'no-op' | 'unparsable' };

export interface BulkOperation {
  readonly opId: OpId;                       // branded, like RowKey
  readonly label: string;                    // "+10% calls"

  /** A Map, not an array: every settle handler finds its entry by rowKey in O(1).
   *  With 5,000 entries an array scan per settle is 12.5M comparisons. */
  readonly entries: ReadonlyMap<RowKey, { rowKey: RowKey; proposed: number; state: BulkEntryState }>;

  /** Running tallies, so progress UI never scans 5,000 entries per frame. */
  readonly counts: { total: number; queued: number; inflight: number;
                     applied: number; rejected: number; skipped: number };

  readonly status: 'running' | 'finalized' | 'cancelled';

  /** Set at finalization — the ONE command for this whole operation (§5.2).
   *  Absent while running, which is why nothing is undoable mid-flight. */
  readonly command: Command | null;
}

readonly bulk: BulkOperation | null;   // a single slot on StoreState, not a list
```

A single slot, because two concurrent operations over overlapping selections would need
per-row arbitration and would make "exactly one undo step" ambiguous — undoing which? A
second "+10%" while one runs is refused with a toast.

**Concurrency: 8 in flight**, not all 5,000. Firing everything means unbounded memory
(5,000 live promises plus 5,000 pending `setTimeout` handles), an unreadable UI (progress
jumps 0→100% in one 900 ms step), and no back-pressure to cancel into — you can cancel a
queue, but not 50,000 already-fired requests, because the validator has no abort path.
Throughput is `concurrency / 0.6s`, so 8 gives ~13 rows/s: a 5,000-row operation takes ~6
minutes, long but honest and cancellable. N workers pull from a shared queue rather than
chunking into batches of 8, since chunking makes every batch wait for its slowest member.

**Per-entry stale guard.** Before firing, `attempt()` checks that the operation is still
current and running; that this entry is still `queued`; that the row hasn't been
**superseded** by a single-cell edit (the user's direct intent wins → `skipped`); and it
recomputes the proposal against the **current** committed value, not the value read when
the selection was made — a +10% queued behind six minutes of work must apply to what the
row holds now. After settling, `stillInflight(opId, rowKey, reqId)` checks all three
identities and drops the result entirely on any mismatch — the same guard as the
single-cell path, for the same reason.

### 5.2 The applied subset as exactly ONE undo step

While the operation runs, **nothing is pushed to `history`** — so Ctrl+Z during a bulk
operation undoes whatever the user did *before* it started. At finalization the applied
entries, and only those, become one command:

```ts
const entries = [...op.entries.values()]
  .filter((e) => e.state.kind === 'applied')
  .map((e) => ({ rowKey: e.rowKey, before: e.state.before, after: e.state.after }));

// Everything failed → NO command. An undo step that undoes nothing is worse than no
// step: it consumes a Ctrl+Z and appears broken.
if (entries.length === 0) { set({ bulk: { ...op, status: 'finalized', command: null } }); return; }

const command: Command = { kind: 'bulk-edit', id: nextCommandId(), label: op.label, opId, entries };
set({ bulk: { ...op, status: 'finalized', command },
      history: { past: [...past, command].slice(-HISTORY_LIMIT), future: [] } });
```

One `undo()` walks all entries through `writeEntries(..., 'invert')` — **the same function
a single-cell undo uses** — applying N O(1) deltas. No new code path. One command per
accepted entry instead would need 4,300 Ctrl+Z presses to undo one user action and would
blow the 100-command cap 43 times over.

**This half is verified, not just designed.** The runner doesn't exist, but the command it
would produce does, and `bulkCommand.test.ts` builds one by hand exactly as `finalize` would
— five applied entries spanning three territories and two regions, two rejected rows that
were never written — then asserts a single `undo()` reverts all five, that territory *and*
region totals return byte-for-byte to their starting values, and that `committed` is a true
diff again (§6). Without it, "no new code path" was a claim about a branch nothing had ever
taken.

Values are written to `committed` **per entry** as each is accepted, so rows land and
subtotals climb during a six-minute operation; only the *history entry* is deferred.
Deferring the values too would mean a third map holding accepted results outside
`committed`, collapsing the §1 distinction back in.

*Known gap:* cancelling mid-operation currently skips the command, so a user who cancels at
60% can't undo the 60%. Two-line change, but it needs a product decision on whether a
cancelled operation is one undo step or none.

### 5.3 The other three FR-6 cases

**Row inside a collapsed group** — implemented for single-cell edits, identical for bulk.
`invertCommand` writes the values **first and unconditionally**; the state change never
depends on what the view shows. Then `revealTarget` picks `entries[0].rowKey` (revealing
all 4,300 is meaningless, so the toast reports the count instead), `expandAncestors` writes
explicit `true` into both intent maps so the group afterwards behaves like one the user
opened, and the grid centres it: `scrollTop = index * 32 − viewportHeight / 2 + 16`. A
1400 ms flash uses an outline as well as a tint, so the cue isn't colour-only.

**Does redo re-validate? No** — see §4. **The condition that makes this safe is specific
and I would not carry it forward blindly: this client is the only writer.** Against a real
backend, redo *would* have to re-validate, and the design changes shape: each `EditEntry`
gains a `baseVersion`; redo submits `{ value, baseVersion }` and the server rejects on
mismatch; a rejected redo doesn't silently drop but becomes a conflict the user resolves
("this row changed to 55 while you were away — keep yours, take theirs, or cancel"); and
the command stays in `future` on conflict rather than being discarded, so it can be retried
after resolving. The current behaviour is correct for this system and would be a bug in a
multi-writer one.

**Row excluded by the current search/filter** — the change is applied, always; a subtotal
for a filtered-out row is still that territory's subtotal. `rowFilterBlock` returns
`'search' | 'region' | 'both' | null` in O(1). If blocked, **no filter is changed behind
the user's back** — they typed that search for a reason. A toast explains and offers "Show
it", which clears **only** the filters actually in the way. For a bulk undo split across
the boundary, the toast reports the split: *"4,300 rows reverted; 120 are hidden by the
current search."*

### 5.4 Event flow — one failing bulk operation, end to end

Selection: 3 rows. A holds 20, B holds 30, C is one of the 99999 outliers.

1. User selects A, B, C; clicks **+10% calls**. Store creates
   `BulkOperation { opId: 1, status: 'running', command: null }` with three `queued`
   entries; selection cleared so buttons can't double-fire. **`history.past` untouched.**
2. `runQueue` starts `min(8, 3) = 3` workers. A: 20 → 22 (`reqId 41`); B: 30 → 33
   (`reqId 42`); C: 99999 → 109999 (`reqId 43`). Three pending cells; **subtotals have not
   moved.**
3. **t+340 ms** — `reqId 42` resolves. `committed.set(B, 33)`, `applyCallsChange(+3)`;
   B → `applied {before: 30, after: 33}`, its subtotal climbs by 3. **Still no history entry.**
4. **t+610 ms** — `reqId 43` rejects (cap). C → `rejected {kind:'cap'}`; its cell reverts —
   it was never written — and shows ⚠.
5. **t+780 ms** — `reqId 41` rejects (503). A → `rejected {kind:'transient'}`.
6. Queue empty, nothing in flight → `finalize(1)`. One entry survives (B: 30→33), so **one**
   command is pushed; `future` cleared.
7. Summary panel — persistent, not a toast, because an operation that took six minutes
   deserves a result the user can read at their own pace:
   **"+10% calls — 1 applied, 2 rejected"**, grouped as `1 × 503 — transient [Retry]` and
   `1 × call cap — permanent [Show]`. "Retry" starts a **new** operation with its own
   command and undo step; re-entering the finalized one would mean its command grows after
   being pushed to history.
8. **Ctrl+Z once.** `undo()` finds no in-flight rows, calls `writeEntries([B], 'invert')` →
   writes `before: 30`, and because 30 *is* B's source value the key is **deleted** from
   `committed`. One O(1) delta of −3. The two rejected rows are unaffected — nothing was
   ever committed for them. `revealRow(B)` expands ancestors, centres B, flashes it.
9. **Late arrival — the case this design exists for.** At t+1200 ms a settle arrives for a
   `reqId` from a cancelled operation. `stillInflight` fails the `opId` check and the result
   is discarded. Nothing is written, because the pending state never wrote to `committed`
   in the first place.

---

## 6. Theming (FR-8), performance, testing

`sanitizeTheme(raw: unknown)` is an **allowlist, never a blocklist** — the
security-relevant decision, because these values reach CSS custom properties, and
`primary: "red; background-image: url(…)"` terminates the declaration and injects a second
one. A blocklist is the wrong *shape* of defence: CSS has too many equivalent encodings
(`\75 rl`, comment splitting) for "does not contain `url(`" to mean anything, whereas
`/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/` has no escape hatch. Fifteen hostile inputs are
tested; none needed individual anticipation.

| Field | Rule | Why |
|---|---|---|
| colours | 3-/6-digit hex, **reject** otherwise | Intent is unknowable — `#ZZ8800` might have meant orange, or be a paste accident |
| colours | alpha hex **rejected**, though valid CSS | Semi-transparent `text` destroys contrast, unvalidatable at config time |
| `radius` | finite number, **clamp** 0–24 | Intent *is* legible ("very round"). `'8'` still rejected: coercing numeric strings today means accepting `'8; content: attack'` tomorrow |
| `appName` | trim, non-empty, **truncate** at 64 | An unbounded string is a layout attack |
| unknown tenant | `DEFAULT_THEME`, value **discarded** | Echoing an unvalidated query param into the DOM is reflected XSS |

Applied as six `setProperty` calls — **zero React re-renders**. The `--state-*` tokens sit
deliberately **outside** this surface: rather than validating each tenant palette for
contrast against five state colours (not decidable from the config alone), they're fixed
and each state also carries a glyph. The `meridian` config produces exactly four issues —
`primary` (`"#ZZ8800"`), `radius` (`"huge"`), `onPrimary` and `text` (absent) — while
**preserving** its own `appName`, `background`, and `surface`. Per-field fallback, not
all-or-nothing: one bad colour must not cost the tenant its name. The issue panel is a
collapsed `<details>`, not a banner — the app *works*, so this is diagnostic information,
and a tenant who ships `#ZZ8800` and sees default blue otherwise cannot tell whether their
config was ignored, mis-parsed, or never loaded.

**Performance**, measured by `performance.bench.test.ts` — a measurement harness, not a
regression gate, since a wall-clock threshold in CI fails on a busy machine and teaches the
team to re-run rather than read:

| Decision | Naive | Chosen | Factor |
|---|---|---|---|
| Aggregates on an accepted edit | 3.5 ms recompute | 2.5 µs delta | **1,429×** |
| Sorting on a column click | 37.7 ms global | 0.5 ms per open group | **75×**, and collapsed groups sort **not at all** |
| Search per keystroke | inline `.toLowerCase()` → 100,000 allocations/char | precomputed arrays | no allocation on the keystroke path |
| Territory buckets | 48 allocations per filter | one CSR buffer + `subarray` | 1 |
| Unfiltered state | copy 50,000 indices | reuse the group index's arrays | **0** at rest |
| Scroll handling | 20 events → 20 renders | rAF + range bail-out | 20 → **1** frame |
| Rows in the DOM | 50,054 | 26 at rest / 32 mid-list | **~1,500×** |

Dataset build is **62.9 ms**, paid once. Two findings came from the footer instrumentation
itself: **stage D was recomputing on every keystroke** (group ordering consumed stage C's
output, which carries per-group *visible* counts and so produced a new object per
keystroke; fixed by depending on `Aggregates` directly), and **`buildMs` under-reported by
a third** because `projectRows` started its timer after `generateRows` returned — a number
documented as "generation + projection + grouping" was reporting 39 ms of a 63 ms
operation, and it was headed for this README. **Not measured:** real-browser frame timing.
The DOM row count *is* asserted, so "only visible rows exist in the DOM" is verified; "60
fps" is **argued** from the row count and the three scroll optimisations, not profiled.

**Testing — 387 tests, 20 files**, three consecutive runs, no flakes. The real validator
settles after 300–900 ms and fails 10% at random, so `fakeValidator.ts` exposes
`settle(id, outcome)` for **manual control, not fake timers** — fake timers make the
*latency* deterministic but not the *order*, and order is what's under test. `settle`
throws on an unknown or already-settled id, so a test that settles the wrong call fails
loudly rather than asserting nothing.

| Test | What it proves |
|---|---|
| `leaves EVERY aggregate byte-identical while in flight` | Snapshots 54 groups × 5 measures, edits, asserts deep equality while pending, settles, asserts the change is exactly the delta |
| `drops a late result whose cell is no longer pending on its ticket` | Nothing committed, no history entry |
| `drops a stale REJECTION as well as a stale success` | The guard is on both paths |
| `edits row 9973 without touching row 9972` | Row identity, against the real colliding pair |
| `undo is independent of sort/filter/grouping` | Edit → re-sort → filter away → undo → reverted, reveal fired with `blockedBy: 'search'` |
| `keeps the DOM row count flat while scrolling 50,000 rows` | FR-1's core claim |
| `matches a fresh full recompute after 200 randomised edits` | Five fixed seeds — the delta path can't drift from the oracle |
| `rejects 15 hostile theme inputs` | The allowlist, including CSS injection and prototype pollution |
| `a bulk-edit command is exactly ONE undo step` | §5.2's central claim, as a property rather than an assertion — see below |

**Testing a design deliverable's primitive.** FR-5/FR-6 are design-only, so there is no
bulk runner to test. But §5.2 claims the applied subset becomes *one* command that inverts
through the same `writeEntries` a single-cell undo uses — and every other test exercises
`cell-edit`, whose `entry` is a single object. The `bulk-edit` variant had never been
constructed anywhere, so the multi-entry claim was an assertion about code that had never
run. `bulkCommand.test.ts` hand-builds the command `finalize(opId)` would build — five
applied entries across three territories and two regions, two rejected rows left untouched —
and asserts one `undo()` reverts all five, both aggregate levels return to their exact
starting numbers, `committed` is empty again, and redo re-applies in one step with zero
validator calls. It also covers the refusal while a row in the command is in flight, and the
empty-subset case where no command is pushed at all. Verified by mutation: capping
`writeEntries` to the first entry fails 3 of the 9; dropping the region-level delta fails 1.
**This is not FR-5** — no runner, no queue, no selection UI. It is the undo primitive the
design rests on, now proven to hold at more than one entry.

Property tests use **fixed, named seeds**: a test that fails once in fifty runs and can't be
reproduced trains you to re-run CI instead of reading the failure. **Not covered:** the FR-5
bulk *runner* — concurrency queue, per-entry stale guard, partial-failure summary (design
only, §5); real-browser rendering; visual regression; arrow-key navigation between cells.

---

## 7. What I'd do differently, and what's deliberately not done

1. **Measure in a real browser before claiming 60 fps.** Everything above is algorithmic.
   I'm confident about the DOM row count because it's asserted; I'm *arguing* about frame rate.
2. **Reconsider the fixed 32 px row height.** It reduces the maths to a division, which
   bought the whole of §3 — but a long name truncates rather than wraps, and it won't take a
   two-line row. Dynamic heights are where a virtualization library earns its place, and
   adding them later is a rewrite of the hook, not an extension.
3. **Build the FR-5 bulk path.** Designed to the point where implementing it is mostly
   mechanical, and the design would be *better* for it — §5.2's cancellation gap is exactly
   what surfaces on contact with real code.
4. **Extract `commitEdit`.** ~90 lines, eight labelled steps. The guard sequence is
   deliberately linear and I wouldn't split it into eight functions that hide the order —
   but the accept and reject branches could each be a pure function returning a state patch.
5. **Replace byte-order collation with `Intl.Collator`.** Correct for this ASCII dataset,
   wrong for accents or non-Latin scripts. A known limitation, not an oversight.

| Deliberately not done | Why |
|---|---|
| FR-5 / FR-6 **in code** | Design deliverables per the brief (§5). Chose depth on FR-4's concurrency over breadth. The single-cell undo path FR-4 requires *is* built, including the collapsed-group and hidden-row cases |
| Real-browser performance trace | The biggest gap in the evidence (§6) |
| Arrow-key navigation between cells | Enter/Esc/F2/double-click work. Full navigation across a virtualized list needs focus restoration when a focused row unmounts mid-scroll — a real design problem I'd rather not half-do |
| Column pinning / resize / reorder | Listed bonus. `COLUMNS` + `GRID_TEMPLATE` is the extension point; pinning is `position: sticky` on the first *n* tracks |
| A third grouping level | Listed bonus. The architecture takes it: `FlatRow` is a discriminated union with an exhaustive `never` check, so adding a level is a compile error at every site that must change |
| Row selection UI | The `selection` set and its actions exist and are tested, because FR-5's design needs them. Checkboxes aren't rendered: a checkbox whose only action is unimplemented is worse than none |
| Persistence | No requirement, and it would force the row-identity question before there's a server to answer it |
| Hoisting sort keys into an `n`-length array | A Schwartzian transform would cut key extractions from `2 · n log n` to `n`. Not done, deliberately: sorting is per-territory (~1,042 rows) and only for expanded groups, so a column click is ~0.5 ms per open group — and `sortedTerritoryRows` already serves repeat renders from a cache, so the common case never reaches the sort at all. It would add a per-column key buffer and a second path for the null-last rule to buy a win that sits underneath an existing cache. Worth revisiting only if row-level sorting ever moves above a single territory |

---

## 8. Time spent

# Time spent

Approximately 18–20 hours. The work was primarily focused on building and validating the core data and state model, followed by the features that required the most coordination between different parts of the application. The edit workflow, asynchronous updates, and undo/redo behavior required additional attention to ensure state transitions remained predictable and consistent.

A significant portion of the time was also spent validating the underlying dataset and defining consistent rules for grouping, aggregation, sorting, filtering, and comparisons before connecting them to the UI. This helped identify data edge cases early and avoid carrying incorrect assumptions into the implementation.

The remaining effort covered the virtualized grid, group headers, defect handling, toolbar/footer interactions, theming, and documentation. FR-5/FR-6 were considered at the design level but were not implemented, as defined by the scope. Documentation and final validation were also included to ensure the implementation, assumptions, and stated requirements remained consistent.
