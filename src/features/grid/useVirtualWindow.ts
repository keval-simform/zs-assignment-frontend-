import { useCallback, useEffect, useRef, useState } from 'react';

export interface VirtualWindow {
  /** First rendered index, overscan included. */
  readonly start: number;
  /** One past the last rendered index. */
  readonly end: number;
  /** Pixels to translate the rendered window down by. */
  readonly offsetY: number;
}

export interface VirtualWindowResult {
  readonly scrollRef: React.RefObject<HTMLDivElement>;
  readonly window: VirtualWindow;
  /** Height of the spacer that gives the scrollbar its range. */
  readonly totalHeight: number;
  /** How many rows the viewport can show, excluding overscan. Footer diagnostic. */
  readonly viewportRows: number;
}

const EMPTY_WINDOW: VirtualWindow = { start: 0, end: 0, offsetY: 0 };

/**
 * FR-1: hand-rolled windowing over a uniform-height list.
 *
 * No virtualization library: uniform row heights reduce the problem to two
 * divisions, and everything a library would add — measurement caching, dynamic
 * heights, imperative scroll APIs — is either unneeded here or something we need to
 * control directly for `revealRow`.
 *
 * Max scroll height is not a concern at this scale: 50,054 rows × 32 px ≈ 1.60M px,
 * against a limit of roughly 33.5M px in Chrome and 17.9M px in Firefox — ~11×
 * headroom, so no scroll-scaling or segmented-spacer hack is needed. That would
 * start to matter around 500,000 rows.
 */
export function useVirtualWindow(count: number, rowHeight: number, overscan: number): VirtualWindowResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [window_, setWindow] = useState<VirtualWindow>(EMPTY_WINDOW);
  const [viewportHeight, setViewportHeight] = useState(0);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;

    const visible = Math.ceil(el.clientHeight / rowHeight);
    const first = Math.floor(el.scrollTop / rowHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(count, first + visible + overscan);

    // PERF: bail out when the computed range is unchanged. A 4px scroll inside a
    // 32px row produces the identical window; without this, every such event would
    // re-render 40 rows for no visual change. Returning the previous object
    // reference makes React skip the update entirely.
    setWindow((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end, offsetY: start * rowHeight },
    );
    setViewportHeight((prev) => (prev === el.clientHeight ? prev : el.clientHeight));
  }, [count, rowHeight, overscan]);

  const onScroll = useCallback(() => {
    // PERF: coalesce to one measurement per frame. A trackpad or smooth-scrolling
    // wheel fires scroll events faster than the compositor paints — several per
    // frame on a 120Hz trackpad — each of which would otherwise schedule a render
    // the next event immediately supersedes.
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;

    // PERF: passive listener — tells the browser this handler never calls
    // preventDefault, so scrolling isn't blocked waiting for JS to run.
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [onScroll]);

  // Re-measure when the row count changes (a group expanded, a filter applied).
  // Without this, expanding a group would leave the window sized for the old,
  // shorter list.
  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [measure]);

  return {
    scrollRef,
    window: window_,
    totalHeight: count * rowHeight,
    viewportRows: viewportHeight === 0 ? 0 : Math.ceil(viewportHeight / rowHeight),
  };
}
