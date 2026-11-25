import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * Automatically scales its child content uniformly so it always fits
 * completely inside the available container width & height with zero clipping or scrollbars.
 * When `fillWidth` is true, expands the unscaled layout width so the scaled result
 * stretches edge-to-edge across 100% of the container's available width.
 */
export default function AutoFitBox({
  children,
  className = '',
  maxScale = 1,
  align = 'center',
  fillWidth = false,
}) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [layout, setLayout] = useState({ scale: 1, width: null });

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return undefined;

    const recalc = () => {
      const availW = outer.clientWidth;
      const availH = outer.clientHeight;
      if (!availW || !availH) return;

      // Measure natural unstretched content dimensions cleanly
      const prevWidth = inner.style.width;
      inner.style.width = 'max-content';
      const naturalW = inner.scrollWidth;
      const naturalH = inner.scrollHeight;

      if (!naturalW || !naturalH) {
        inner.style.width = prevWidth;
        return;
      }

      const rawScale = Math.min(maxScale, availW / naturalW, availH / naturalH);
      let nextScale = Math.max(0.18, Math.floor(rawScale * 10000) / 10000);
      let targetWidth = null;

      if (fillWidth) {
        targetWidth = Math.max(naturalW, Math.floor(availW / nextScale));
        inner.style.width = `${targetWidth}px`;
        const postH = inner.scrollHeight;
        if (postH > naturalH) {
          const adjusted = Math.min(maxScale, availW / targetWidth, availH / postH);
          nextScale = Math.max(0.18, Math.floor(adjusted * 10000) / 10000);
          targetWidth = Math.max(naturalW, Math.floor(availW / nextScale));
        }
      }

      inner.style.width = targetWidth ? `${targetWidth}px` : '';

      setLayout((prev) => {
        if (
          Math.abs(prev.scale - nextScale) < 0.0005 &&
          prev.width === targetWidth
        ) {
          return prev;
        }
        return { scale: nextScale, width: targetWidth };
      });
    };

    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(outer);
    if (!fillWidth) {
      ro.observe(inner);
    }

    let cancelled = false;
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) recalc();
      });
    }

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [maxScale, fillWidth, children]);

  return (
    <div
      ref={outerRef}
      className={`autofit-outer align-${align} ${className}`}
    >
      <div
        ref={innerRef}
        className="autofit-inner"
        style={{
          width: layout.width ? `${layout.width}px` : undefined,
          transform: `scale(${layout.scale})`,
          transformOrigin: align === 'left' ? 'top left' : 'center center',
        }}
      >
        {children}
      </div>
    </div>
  );
}
