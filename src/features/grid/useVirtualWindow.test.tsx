import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubViewportHeight, TEST_VIEWPORT_HEIGHT } from '../../test/renderGrid';
import { useVirtualWindow } from './useVirtualWindow';

const ROW_HEIGHT = 32;
const OVERSCAN = 6;

interface Observed {
  start: number;
  end: number;
  offsetY: number;
  totalHeight: number;
  renders: number;
}

function Harness({ count, observed }: { count: number; observed: Observed }): JSX.Element {
  const { scrollRef, window: win, totalHeight } = useVirtualWindow(count, ROW_HEIGHT, OVERSCAN);
  observed.start = win.start;
  observed.end = win.end;
  observed.offsetY = win.offsetY;
  observed.totalHeight = totalHeight;
  observed.renders += 1;
  return <div ref={scrollRef} style={{ height: TEST_VIEWPORT_HEIGHT, overflow: 'auto' }} />;
}

let restore: () => void;
beforeEach(() => {
  restore = stubViewportHeight();
});
afterEach(() => {
  restore();
  jest.restoreAllMocks();
});

function observe(): Observed {
  return { start: 0, end: 0, offsetY: 0, totalHeight: 0, renders: 0 };
}

describe('useVirtualWindow', () => {
  it('sizes the spacer to the full list, not the window', () => {
    const observed = observe();
    render(<Harness count={50_054} observed={observed} />);
    // 50,054 rows x 32px = 1,601,728px, ~11x under Chrome's ~33.5M px cap. No
    // scroll-scaling hack needed at this scale.
    expect(observed.totalHeight).toBe(50_054 * ROW_HEIGHT);
  });

  it('renders viewport rows plus overscan, and nothing more', async () => {
    const observed = observe();
    render(<Harness count={10_000} observed={observed} />);
    await waitFor(() => {
      expect(observed.end).toBeGreaterThan(0);
    });
    // 640 / 32 = 20 visible; at scrollTop 0 the leading overscan is clamped away.
    expect(observed.start).toBe(0);
    expect(observed.end).toBe(20 + OVERSCAN);
  });

  it('translates the window by whole rows', async () => {
    const observed = observe();
    const { container } = render(<Harness count={10_000} observed={observed} />);
    const scroller = container.firstElementChild;
    expect(scroller).toBeInstanceOf(HTMLElement);
    if (!(scroller instanceof HTMLElement)) return;

    await waitFor(() => {
      expect(observed.end).toBeGreaterThan(0);
    });
    act(() => {
      scroller.scrollTop = 3_200; // exactly 100 rows
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => {
      expect(observed.start).toBe(100 - OVERSCAN);
    });
    expect(observed.offsetY).toBe((100 - OVERSCAN) * ROW_HEIGHT);
    expect(observed.end - observed.start).toBe(20 + 2 * OVERSCAN);
  });

  it('does NOT re-render for a scroll that leaves the window unchanged', async () => {
    // PERF under test: a 4px scroll inside a 32px row yields the identical range.
    // Without the bail-out this would re-render 40 rows for no visual change.
    const observed = observe();
    const { container } = render(<Harness count={10_000} observed={observed} />);
    const scroller = container.firstElementChild;
    if (!(scroller instanceof HTMLElement)) throw new Error('no scroller');

    await waitFor(() => {
      expect(observed.end).toBeGreaterThan(0);
    });
    const before = observed.renders;

    for (const top of [1, 2, 3, 4, 5]) {
      act(() => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event('scroll'));
      });
      await Promise.resolve();
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(null);
      });
    });

    expect(observed.renders).toBe(before);
  });

  it('coalesces a burst of scroll events into one measurement', async () => {
    // PERF under test: a 120Hz trackpad fires several scroll events per frame.
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
    const observed = observe();
    const { container } = render(<Harness count={10_000} observed={observed} />);
    const scroller = container.firstElementChild;
    if (!(scroller instanceof HTMLElement)) throw new Error('no scroller');

    await waitFor(() => {
      expect(observed.end).toBeGreaterThan(0);
    });
    raf.mockClear();

    act(() => {
      for (let i = 1; i <= 20; i++) {
        scroller.scrollTop = i * 100;
        scroller.dispatchEvent(new Event('scroll'));
      }
    });

    // 20 events, one frame scheduled.
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('registers the scroll listener as passive', () => {
    const observed = observe();
    const addSpy = jest.spyOn(HTMLElement.prototype, 'addEventListener');
    render(<Harness count={100} observed={observed} />);
    // React's own delegated listeners also register for 'scroll' (with capture),
    // so assert that OUR registration is among them rather than picking the first.
    const scrollCalls = addSpy.mock.calls.filter((call) => call[0] === 'scroll');
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.some((call) => JSON.stringify(call[2]) === JSON.stringify({ passive: true }))).toBe(true);
  });

  it('clamps the window to the list when it is shorter than the viewport', async () => {
    const observed = observe();
    render(<Harness count={3} observed={observed} />);
    await waitFor(() => {
      expect(observed.end).toBe(3);
    });
    expect(observed.start).toBe(0);
  });

  it('re-measures when the row count changes', async () => {
    // Expanding a group changes `count`; without the dependency the window would
    // stay sized for the old, shorter list.
    const observed = observe();
    const { rerender } = render(<Harness count={5} observed={observed} />);
    await waitFor(() => {
      expect(observed.end).toBe(5);
    });
    rerender(<Harness count={1_000} observed={observed} />);
    await waitFor(() => {
      expect(observed.end).toBe(20 + OVERSCAN);
    });
  });

  it('handles an empty list', async () => {
    const observed = observe();
    render(<Harness count={0} observed={observed} />);
    await waitFor(() => {
      expect(observed.totalHeight).toBe(0);
    });
    expect(observed.end).toBe(0);
  });
});
