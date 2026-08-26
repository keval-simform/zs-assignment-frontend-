import type { LoadedData } from './normalize';
import { RowFlag, callsAt, hasFlag, rowAt, trxAt } from './normalize';
import { territoryRowCount } from './grouping';
import { readItem, readU8 } from './typed';
import { asRowKey, asTerritoryIndex } from './identity';
import { EM_DASH, formatCpi, groupCpi, rowCpi } from './cpi';

/**
 * What the census needs: the data and the build cost, not the whole `LoadedData`.
 * Stated as a `Pick` so a caller assembling it by hand (the app shell does) does
 * not have to invent timing fields it has no opinion about.
 */
export type CensusInput = Pick<LoadedData, 'dataset' | 'groups' | 'buildMs'>;

export interface DuplicateIdGroup {
  readonly id: string;
  readonly rowKeys: readonly number[];
}

/**
 * How much a group's aggregate CPI is moved by the outlier rows inside it.
 *
 * This is not a defect the brief names; it is the *consequence* of one, and it
 * turned out to be the most important thing the census found. See §A4b in
 * ASSUMPTIONS.md.
 */
export interface OutlierImpact {
  readonly scope: string;
  readonly outlierRows: number;
  readonly cpi: number | null;
  readonly cpiExcludingOutliers: number | null;
  /** Percent by which the outliers inflate the reported CPI. */
  readonly distortionPct: number | null;
}

export interface DefectCensus {
  readonly seed: number;
  readonly totalRows: number;

  readonly duplicateIdCount: number;
  readonly duplicateIdRowCount: number;
  readonly duplicateIdGroups: readonly DuplicateIdGroup[];

  readonly nullSpecialtyCount: number;

  readonly stringCallsCount: number;
  readonly unparsableCallsCount: number;
  readonly callsMin: number;
  readonly callsMax: number;
  readonly callsAboveCapCount: number;
  readonly outlierRowKeys: readonly number[];

  readonly zeroTrxCount: number;
  readonly zeroTrxSeededCount: number;
  readonly zeroTrxNaturalCount: number;
  readonly nullRowCpiCount: number;

  readonly uniqueNameCount: number;
  readonly duplicateNameRowCount: number;
  readonly maxRowsPerName: number;

  readonly regionKeys: readonly string[];
  readonly territoryCount: number;
  readonly territoryRowMin: number;
  readonly territoryRowMax: number;
  readonly territoryRowMean: number;

  /** Region- and territory-level CPI distortion caused by the 4 outlier rows. */
  readonly outlierImpact: readonly OutlierImpact[];

  readonly buildMs: number;
}

/** The per-HCP call cap the validator enforces; used here only to count violations. */
const VALIDATOR_CAP = 60;
/** The generator's seeded zero-TRx rule, replicated ONLY to separate seeded from natural. */
const SEEDED_ZERO_TRX_MODULUS = 577;

/**
 * Measures the dataset's data-quality defects.
 *
 * DECISION: exists as production code rather than as assertions buried in a
 * test, and every number in ASSUMPTIONS.md is copied from its output. A count
 * inferred by reading `i % 577 === 0` and dividing is a *guess* — it misses
 * that `trx` also hits zero by chance. Counting the actual rows is the only
 * way to find that out.
 */
export function census(loaded: CensusInput): DefectCensus {
  const { dataset: d, groups: g, buildMs } = loaded;

  const idRows = new Map<string, number[]>();
  const nameCounts = new Map<string, number>();

  let nullSpecialtyCount = 0;
  let stringCallsCount = 0;
  let unparsableCallsCount = 0;
  let callsMin = Number.POSITIVE_INFINITY;
  let callsMax = Number.NEGATIVE_INFINITY;
  let callsAboveCapCount = 0;
  const outlierRowKeys: number[] = [];
  let zeroTrxCount = 0;
  let zeroTrxSeededCount = 0;
  let nullRowCpiCount = 0;

  for (let i = 0; i < d.count; i++) {
    const k = asRowKey(i);
    const row = rowAt(d, k);

    const bucket = idRows.get(row.id);
    if (bucket === undefined) idRows.set(row.id, [i]);
    else bucket.push(i);

    nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);

    if (hasFlag(d, k, RowFlag.NullSpecialty)) nullSpecialtyCount++;
    if (hasFlag(d, k, RowFlag.StringCalls)) stringCallsCount++;

    const calls = callsAt(d, k);
    if (calls === null) unparsableCallsCount++;
    else {
      if (calls < callsMin) callsMin = calls;
      if (calls > callsMax) callsMax = calls;
      if (calls > VALIDATOR_CAP) {
        callsAboveCapCount++;
        outlierRowKeys.push(i);
      }
    }

    const trx = trxAt(d, k);
    if (trx === 0) {
      zeroTrxCount++;
      if (i > 0 && i % SEEDED_ZERO_TRX_MODULUS === 0) zeroTrxSeededCount++;
    }
    if (rowCpi(calls, trx) === null) nullRowCpiCount++;
  }

  const duplicateIdGroups: DuplicateIdGroup[] = [];
  let duplicateIdRowCount = 0;
  for (const [id, rowKeys] of idRows) {
    if (rowKeys.length > 1) {
      duplicateIdGroups.push({ id, rowKeys });
      duplicateIdRowCount += rowKeys.length;
    }
  }
  duplicateIdGroups.sort((a, b) => (a.rowKeys[0] ?? 0) - (b.rowKeys[0] ?? 0));

  let duplicateNameRowCount = 0;
  let maxRowsPerName = 0;
  for (const seen of nameCounts.values()) {
    if (seen > 1) duplicateNameRowCount += seen;
    if (seen > maxRowsPerName) maxRowsPerName = seen;
  }

  let territoryRowMin = Number.POSITIVE_INFINITY;
  let territoryRowMax = 0;
  for (let t = 0; t < g.territoryCount; t++) {
    const n = territoryRowCount(g, asTerritoryIndex(t));
    if (n < territoryRowMin) territoryRowMin = n;
    if (n > territoryRowMax) territoryRowMax = n;
  }

  const outlierImpact = measureOutlierImpact(loaded, outlierRowKeys);

  return {
    seed: d.seed,
    totalRows: d.count,
    duplicateIdCount: duplicateIdGroups.length,
    duplicateIdRowCount,
    duplicateIdGroups,
    nullSpecialtyCount,
    stringCallsCount,
    unparsableCallsCount,
    callsMin,
    callsMax,
    callsAboveCapCount,
    outlierRowKeys,
    zeroTrxCount,
    zeroTrxSeededCount,
    zeroTrxNaturalCount: zeroTrxCount - zeroTrxSeededCount,
    nullRowCpiCount,
    uniqueNameCount: nameCounts.size,
    duplicateNameRowCount,
    maxRowsPerName,
    regionKeys: g.regionKeys,
    territoryCount: g.territoryCount,
    territoryRowMin,
    territoryRowMax,
    territoryRowMean: d.count / g.territoryCount,
    outlierImpact,
    buildMs,
  };
}

/**
 * Measure how far the outlier rows move each affected group's aggregate CPI.
 *
 * Reported for every region plus only the territories that actually contain an
 * outlier — listing 44 territories with 0% distortion would bury the four that
 * matter.
 */
function measureOutlierImpact(
  loaded: CensusInput,
  outlierRowKeys: readonly number[],
): readonly OutlierImpact[] {
  const { dataset: d, groups: g } = loaded;
  const outlierSet = new Set(outlierRowKeys);

  const acc = (scopeCount: number): { calls: number[]; callsClean: number[]; trx: number[]; rows: number[] } => ({
    calls: new Array<number>(scopeCount).fill(0),
    callsClean: new Array<number>(scopeCount).fill(0),
    trx: new Array<number>(scopeCount).fill(0),
    rows: new Array<number>(scopeCount).fill(0),
  });
  const byRegion = acc(g.regionCount);
  const byTerritory = acc(g.territoryCount);

  for (let i = 0; i < d.count; i++) {
    const k = asRowKey(i);
    const calls = callsAt(d, k) ?? 0;
    const trx = trxAt(d, k);
    const isOutlier = outlierSet.has(i);
    for (const [bucket, group] of [
      [byRegion, readU8(g.regionOf, i)] as const,
      [byTerritory, readU8(g.territoryOf, i)] as const,
    ]) {
      bucket.calls[group] = (bucket.calls[group] ?? 0) + calls;
      bucket.trx[group] = (bucket.trx[group] ?? 0) + trx;
      if (isOutlier) bucket.rows[group] = (bucket.rows[group] ?? 0) + 1;
      else bucket.callsClean[group] = (bucket.callsClean[group] ?? 0) + calls;
    }
  }

  const impact = (scope: string, calls: number, callsClean: number, trx: number, rows: number): OutlierImpact => {
    const cpi = groupCpi(calls, trx);
    const cpiExcludingOutliers = groupCpi(callsClean, trx);
    const distortionPct =
      cpi === null || cpiExcludingOutliers === null || cpiExcludingOutliers === 0
        ? null
        : ((cpi - cpiExcludingOutliers) / cpiExcludingOutliers) * 100;
    return { scope, outlierRows: rows, cpi, cpiExcludingOutliers, distortionPct };
  };

  const out: OutlierImpact[] = [];
  for (let r = 0; r < g.regionCount; r++) {
    out.push(
      impact(
        readItem(g.regionKeys, r),
        byRegion.calls[r] ?? 0,
        byRegion.callsClean[r] ?? 0,
        byRegion.trx[r] ?? 0,
        byRegion.rows[r] ?? 0,
      ),
    );
  }
  for (let t = 0; t < g.territoryCount; t++) {
    if ((byTerritory.rows[t] ?? 0) === 0) continue;
    out.push(
      impact(
        readItem(g.territoryKeys, t),
        byTerritory.calls[t] ?? 0,
        byTerritory.callsClean[t] ?? 0,
        byTerritory.trx[t] ?? 0,
        byTerritory.rows[t] ?? 0,
      ),
    );
  }
  return out;
}

/** Human-readable census, pasted verbatim into ASSUMPTIONS.md. */
export function formatCensus(c: DefectCensus): string {
  const dupSample = c.duplicateIdGroups
    .map((grp) => `${grp.id} @ rows [${grp.rowKeys.join(', ')}]`)
    .join('\n                       ');

  return [
    `DATA FORENSICS — generateRows(${c.seed}, ${c.totalRows})`,
    `  build time             ${c.buildMs.toFixed(1)} ms (generate + project + group)`,
    ``,
    `  IDENTITY`,
    `  duplicate ids          ${c.duplicateIdCount} ids spanning ${c.duplicateIdRowCount} rows`,
    `                       ${dupSample}`,
    `  unique names           ${c.uniqueNameCount} across ${c.totalRows} rows`,
    `  rows sharing a name    ${c.duplicateNameRowCount} (worst name repeats ${c.maxRowsPerName}x)`,
    ``,
    `  CALLS (number | string union)`,
    `  string-typed calls     ${c.stringCallsCount}`,
    `  unparsable calls       ${c.unparsableCallsCount}`,
    `  range                  ${c.callsMin} .. ${c.callsMax}`,
    `  above validator cap    ${c.callsAboveCapCount} at rows [${c.outlierRowKeys.join(', ')}]`,
    ``,
    `  MISSING / UNDEFINED`,
    `  specialty === null     ${c.nullSpecialtyCount}`,
    `  trx === 0 (total)      ${c.zeroTrxCount}`,
    `    of which seeded      ${c.zeroTrxSeededCount}  (i % ${SEEDED_ZERO_TRX_MODULUS} === 0)`,
    `    of which natural     ${c.zeroTrxNaturalCount}  <-- the trap: index-based rules miss these`,
    `  rows with null CPI     ${c.nullRowCpiCount}`,
    ``,
    `  GROUPING`,
    `  regions                ${c.regionKeys.length}: ${c.regionKeys.join(', ')}`,
    `  territories            ${c.territoryCount}`,
    `  rows per territory     min ${c.territoryRowMin}, max ${c.territoryRowMax}, mean ${c.territoryRowMean.toFixed(1)}`,
    ``,
    `  OUTLIER IMPACT ON AGGREGATE CPI  (4 rows out of ${c.totalRows})`,
    `  ${'scope'.padEnd(20)}${'n'.padStart(2)}  ${'CPI'.padStart(8)}  ${'CPI excl.'.padStart(9)}  distortion`,
    ...c.outlierImpact.map(
      (o) =>
        `  ${o.scope.padEnd(20)}${String(o.outlierRows).padStart(2)}  ` +
        `${formatCpi(o.cpi, 2).padStart(8)}  ${formatCpi(o.cpiExcludingOutliers, 2).padStart(9)}  ` +
        `${o.distortionPct === null ? EM_DASH : `${o.distortionPct >= 0 ? '+' : ''}${o.distortionPct.toFixed(1)}%`}`,
    ),
  ].join('\n');
}
