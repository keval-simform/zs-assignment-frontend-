/**
 * Where pipeline stage timings live.
 *
 * DECISION: a module-scoped mutable record, not store state. Writing these into
 * the store would mean calling `set()` from inside a memoised selector — either a
 * setState-during-render warning or an effect that schedules a second render on
 * every keystroke, with the instrument then changing what it measures.
 *
 * The cost is that the footer can be one frame behind. For a diagnostic readout
 * read at human speed, that is the right trade.
 */
export interface PipelineTimings {
  /** Stage B — search + region filter over the source rows. */
  filterMs: number;
  /** Stage C — visible counts per group. */
  aggregateMs: number;
  /** Stage E — per-territory sort of expanded territories only. */
  sortMs: number;
  /** Stage F — flatten to the display list. */
  flattenMs: number;
  /** How many territories stage E actually sorted, vs how many it skipped. */
  territoriesSorted: number;
  /** Stage E cache hits since load — the evidence that the cache earns its place. */
  sortCacheHits: number;
}

export const pipelineTimings: PipelineTimings = {
  filterMs: 0,
  aggregateMs: 0,
  sortMs: 0,
  flattenMs: 0,
  territoriesSorted: 0,
  sortCacheHits: 0,
};

/** Reset between tests so one case cannot read another's numbers. */
export function resetPipelineTimings(): void {
  pipelineTimings.filterMs = 0;
  pipelineTimings.aggregateMs = 0;
  pipelineTimings.sortMs = 0;
  pipelineTimings.flattenMs = 0;
  pipelineTimings.territoriesSorted = 0;
  pipelineTimings.sortCacheHits = 0;
}
