import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyVariableCompletion,
  buildGrandmaVariableMap,
  filterGrandmaVariables,
  findActiveVariableQuery,
} from '../engine/grandmaVariables.js';

/**
 * Accessible text input with inline `$` contextual variable autocomplete for
 * Grandma's Phrase Manager and Live Grandma Chat inputs.
 * - Triggers automatically when typing `$` (e.g. `$`, `$pl`, `$scor`, `$tab`)
 * - Keyboard navigable: ArrowUp / ArrowDown, Enter / Tab to insert, Escape to dismiss
 * - Smart fixed positioning so it never gets clipped by scroll containers or <dialog> edges
 */
export default function GrandmaPhraseInput({
  value,
  onChange,
  state,
  inputRef: externalRef,
  onKeyDown,
  onFocus,
  onBlur,
  className = '',
  wrapperClassName = '',
  ...rest
}) {
  const internalRef = useRef(null);
  const listboxRef = useRef(null);
  const listboxId = useId();
  const [cursorPos, setCursorPos] = useState(null);
  const [isFocused, setIsFocused] = useState(false);
  const [dismissedRangeKey, setDismissedRangeKey] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [popupStyle, setPopupStyle] = useState(null);

  const setMergedRef = (el) => {
    internalRef.current = el;
    if (typeof externalRef === 'function') {
      externalRef(el);
    } else if (externalRef && typeof externalRef === 'object') {
      externalRef.current = el;
    }
  };

  const activeQuery = useMemo(() => {
    if (!isFocused) return null;
    return findActiveVariableQuery(value, cursorPos ?? String(value || '').length);
  }, [isFocused, value, cursorPos]);

  const rangeKey = activeQuery ? `${activeQuery.start}:${activeQuery.query}` : null;

  const matches = useMemo(() => {
    if (!activeQuery) return [];
    return filterGrandmaVariables(activeQuery.query);
  }, [activeQuery]);

  const liveVarMap = useMemo(() => buildGrandmaVariableMap(state), [state]);

  const isOpen = Boolean(
    isFocused && activeQuery && matches.length > 0 && dismissedRangeKey !== rangeKey
  );

  // Reset active highlight when filter query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [rangeKey]);

  // Compute smart viewport-clamped position (flips above input if near bottom of screen)
  useLayoutEffect(() => {
    if (!isOpen || !internalRef.current) {
      setPopupStyle(null);
      return undefined;
    }
    const updatePosition = () => {
      const el = internalRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const desiredWidth = Math.min(Math.max(rect.width, 300), Math.min(440, vw - 24));
      const left = Math.max(12, Math.min(rect.left, vw - desiredWidth - 12));
      const spaceBelow = vh - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const openUpward = spaceBelow < 185 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(110, Math.min(230, (openUpward ? spaceAbove : spaceBelow) - 8));

      setPopupStyle({
        position: 'fixed',
        left: `${Math.round(left)}px`,
        width: `${Math.round(desiredWidth)}px`,
        maxHeight: `${Math.round(maxHeight)}px`,
        ...(openUpward
          ? { bottom: `${Math.round(vh - rect.top + 6)}px` }
          : { top: `${Math.round(rect.bottom + 6)}px` }),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, matches.length]);

  // Keep highlighted option scrolled into view
  useEffect(() => {
    if (!isOpen || !listboxRef.current) return;
    const activeEl = listboxRef.current.children[activeIndex];
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, isOpen]);

  const selectVariable = (variable) => {
    if (!variable || !activeQuery) return;
    const { value: nextVal, cursorPos: nextPos } = applyVariableCompletion(
      value,
      activeQuery,
      variable.token
    );
    setDismissedRangeKey(null);
    onChange?.(nextVal);
    setCursorPos(nextPos);
    requestAnimationFrame(() => {
      const el = internalRef.current;
      if (el) {
        el.focus();
        if (typeof el.setSelectionRange === 'function') {
          el.setSelectionRange(nextPos, nextPos);
        }
      }
    });
  };

  const handleInputChange = (e) => {
    const nextVal = e.target.value;
    const nextPos = e.target.selectionStart ?? nextVal.length;
    setDismissedRangeKey(null);
    setCursorPos(nextPos);
    onChange?.(nextVal);
  };

  const syncCursor = (e) => {
    setCursorPos(e.target.selectionStart ?? String(value || '').length);
  };

  const handleKeyDownInternal = (e) => {
    if (isOpen && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = matches[activeIndex] || matches[0];
        if (chosen) selectVariable(chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedRangeKey(rangeKey);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const activeOptionId = isOpen && matches[activeIndex]
    ? `${listboxId}-opt-${matches[activeIndex].key}`
    : undefined;

  return (
    <div className={`grandma-ac-wrap ${wrapperClassName}`}>
      <input
        ref={setMergedRef}
        type="text"
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDownInternal}
        onKeyUp={syncCursor}
        onClick={syncCursor}
        onSelect={syncCursor}
        onFocus={(e) => {
          setIsFocused(true);
          syncCursor(e);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur?.(e);
        }}
        className={className}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        {...rest}
      />

      {isOpen && popupStyle && (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label="Grandma contextual variables"
          className="grandma-ac-popover scroller"
          style={popupStyle}
        >
          {matches.map((v, idx) => {
            const liveVal = liveVarMap[v.key.toLowerCase()] ?? '';
            const isActive = idx === activeIndex;
            return (
              <div
                key={v.key}
                id={`${listboxId}-opt-${v.key}`}
                role="option"
                aria-selected={isActive}
                className={`grandma-ac-option ${isActive ? 'is-active' : ''}`}
                onMouseDown={(e) => {
                  // Prevent input blur before click finishes
                  e.preventDefault();
                  selectVariable(v);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <div className="gac-top">
                  <code className="gac-token">{v.token}</code>
                  <span className="gac-val">{liveVal}</span>
                </div>
                <div className="gac-desc">{v.description}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
