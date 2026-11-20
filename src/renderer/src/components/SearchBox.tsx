import { useRef, useState } from 'react';
import { platform } from '../platform';
import { isPhone } from '../web/page-nav';
import { Icon } from './Icon';
import { ICONS } from './icons';

/**
 * An instant Search box as the Windows guidelines draw one: a prompt inside
 * it instead of a label, the magnifying glass as a symbol (not a button) while
 * it's empty, and an "x" that clears it once there's text. Focusing it selects
 * what was typed before; Esc clears it.
 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  // A click that focuses the box would undo the select-on-focus on mouse up.
  const justFocused = useRef(false);
  // A phone's search field keeps the magnifying glass at its start; on an iPhone, Cancel (an xmark in a glass circle) shows beside it while it has the focus.
  const [focused, setFocused] = useState(false);
  const prompt = placeholder ?? (isPhone ? 'Search' : 'Type to search');
  const glass = (
    <Icon size={14} className="search-box-icon">
      {ICONS.search}
    </Icon>
  );
  const field = (
    <>
      {isPhone && glass}
      <input
        ref={(el) => {
          ref.current = el;
          inputRef?.(el);
        }}
        type="text"
        enterKeyHint={isPhone ? 'search' : undefined}
        aria-label={prompt}
        placeholder={prompt}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          e.currentTarget.select();
          justFocused.current = true;
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onMouseUp={(e) => {
          if (justFocused.current) e.preventDefault();
          justFocused.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="search-box-clear"
          aria-label="Clear"
          // The field keeps the focus: losing it would take Cancel away and move this button from under the finger.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        >
          <Icon size={10} bold>
            {ICONS.close}
          </Icon>
        </button>
      ) : (
        !isPhone && glass
      )}
    </>
  );
  if (!isPhone) return <div className="search-box">{field}</div>;
  return (
    <div className="search-box">
      <span className="search-box-field">{field}</span>
      {focused && platform === 'ios' && (
        <button
          type="button"
          className="search-box-cancel"
          aria-label="Cancel"
          // Before the field's blur, which would take the button away first.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            ref.current?.blur();
          }}
        >
          <Icon size={17}>{ICONS.close}</Icon>
        </button>
      )}
    </div>
  );
}
