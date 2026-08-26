import { EM_DASH, formatCpi } from '../../domain/cpi';
import styles from './Grid.module.css';

/**
 * Render a value that may be genuinely unknown.
 *
 * HARD CONSTRAINT 5 lives here in practice: every optional value in the grid goes
 * through one of these, so there is a single place to be sure `NaN`, `Infinity` and
 * the string `"null"` never reach the DOM.
 */
export function MissingValue(): JSX.Element {
  return (
    <span className={styles.missing} aria-label="no value">
      {EM_DASH}
    </span>
  );
}

/** An integer measure, or an em dash when unknown. */
export function IntegerValue({ value }: { value: number | null }): JSX.Element {
  if (value === null || !Number.isFinite(value)) return <MissingValue />;
  return <>{value.toLocaleString()}</>;
}

/** A CPI value, or an em dash when TRx is zero or calls are unknown. */
export function CpiValue({ value }: { value: number | null }): JSX.Element {
  if (value === null) return <MissingValue />;
  const text = formatCpi(value);
  if (text === EM_DASH) return <MissingValue />;
  return <>{text}</>;
}

/** Text that may legitimately be absent, such as the 515 null specialties. */
export function TextValue({ value }: { value: string | null }): JSX.Element {
  if (value === null || value === '') return <MissingValue />;
  return <>{value}</>;
}
