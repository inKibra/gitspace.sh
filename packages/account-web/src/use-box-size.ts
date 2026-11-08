import { useEffect, useState, type RefObject } from 'react';

export interface BoxSize { width: number; height: number }

/** The content box of an element as the browser lays it out, followed as it resizes; null until first measured. */
export function useBoxSize(ref: RefObject<HTMLElement | null>): BoxSize | null {
  const [size, setSize] = useState<BoxSize | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((current) => current && current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
