import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bindField, textOptions } from '../src/renderer/src/components/field-model';
import { ctrlTabTarget, isClear, mostCommon, panelDomId, readableText, tabAria, tabDomId, tabKeyTarget, tabName, tabStop, type TabItem } from '../src/renderer/src/components/tabs-model';
import { resultParts, resultSummary } from '../src/renderer/src/components/workflow-summary';

const tab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({ id, label: id, ...extra });
const ids = ['conversation', 'agent:a', 'agent:b', 'run:r'];

describe('the selected tab color', () => {
  it('takes the color most samples under the tab have, the first of a tie', () => {
    const white = 'rgb(251, 251, 251)';
    const base = 'rgb(243, 243, 243)';
    expect(mostCommon([white, white, base, white, base])).toBe(white);
    expect(mostCommon([base, white])).toBe(base);
    expect(mostCommon([])).toBeNull();
  });

  it('turns the text white over a dark color and black over a light one, only when the text would not read', () => {
    const dark = 'rgb(30, 30, 30)';
    // A terminal's black under the tab: the light theme's dark text turns white.
    expect(readableText('rgb(12, 12, 12)', dark)).toBe('#fff');
    // The dark theme's light text over a light panel turns black.
    expect(readableText('rgb(250, 250, 250)', 'rgb(230, 230, 230)')).toBe('#000');
    // Text that reads well stays as it is.
    expect(readableText('rgb(251, 251, 251)', dark)).toBeNull();
    expect(readableText('color(srgb 0.05 0.05 0.05)', dark)).toBe('#fff');
    expect(readableText('red', dark)).toBeNull();
  });

  it('passes over backgrounds that paint nothing, but not black', () => {
    expect(isClear('rgba(0, 0, 0, 0)')).toBe(true);
    expect(isClear('transparent')).toBe(true);
    expect(isClear('color(srgb 1 1 1 / 0)')).toBe(true);
    expect(isClear('rgb(0, 0, 0)')).toBe(false);
    expect(isClear('rgba(20, 22, 26, 0.5)')).toBe(false);
  });
});

describe('tabKeyTarget', () => {
  it('moves to the neighbor with Left and Right, wrapping at the ends', () => {
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowRight' })).toBe('agent:b');
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowLeft' })).toBe('conversation');
    expect(tabKeyTarget(ids, 'run:r', { key: 'ArrowRight' })).toBe('conversation');
    expect(tabKeyTarget(ids, 'conversation', { key: 'ArrowLeft' })).toBe('run:r');
  });

  it('goes to the first and last with Home and End', () => {
    expect(tabKeyTarget(ids, 'agent:b', { key: 'Home' })).toBe('conversation');
    expect(tabKeyTarget(ids, 'agent:a', { key: 'End' })).toBe('run:r');
  });

  it('leaves other keys and modified arrows alone', () => {
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowDown' })).toBeNull();
    expect(tabKeyTarget(ids, 'agent:a', { key: 'Tab' })).toBeNull();
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowRight', ctrlKey: true })).toBeNull();
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowLeft', altKey: true })).toBeNull();
    expect(tabKeyTarget([], 'x', { key: 'Home' })).toBeNull();
  });

  it('starts from the first tab when none is active', () => {
    expect(tabKeyTarget(ids, 'gone', { key: 'ArrowRight' })).toBe('agent:a');
  });

  it('moves with Up and Down, not Left and Right, down a vertical column', () => {
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowDown' }, 'vertical')).toBe('agent:b');
    expect(tabKeyTarget(ids, 'conversation', { key: 'ArrowUp' }, 'vertical')).toBe('run:r');
    expect(tabKeyTarget(ids, 'agent:a', { key: 'End' }, 'vertical')).toBe('run:r');
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowRight' }, 'vertical')).toBeNull();
    expect(tabKeyTarget(ids, 'agent:a', { key: 'ArrowDown', ctrlKey: true }, 'vertical')).toBeNull();
  });
});

describe('ctrlTabTarget', () => {
  it('cycles forward with Ctrl+Tab and back with Ctrl+Shift+Tab, wrapping', () => {
    expect(ctrlTabTarget(ids, 'agent:a', { key: 'Tab', ctrlKey: true })).toBe('agent:b');
    expect(ctrlTabTarget(ids, 'run:r', { key: 'Tab', ctrlKey: true })).toBe('conversation');
    expect(ctrlTabTarget(ids, 'conversation', { key: 'Tab', ctrlKey: true, shiftKey: true })).toBe('run:r');
  });

  it('ignores a plain Tab and other Ctrl keys', () => {
    expect(ctrlTabTarget(ids, 'agent:a', { key: 'Tab' })).toBeNull();
    expect(ctrlTabTarget(ids, 'agent:a', { key: 'ArrowRight', ctrlKey: true })).toBeNull();
  });
});

describe('tab roles', () => {
  it('has one Tab stop: the active tab, or the first when none is active', () => {
    expect(tabStop(ids, 'agent:b')).toBe('agent:b');
    expect(tabStop(ids, 'gone')).toBe('conversation');
    const stops = ids.map((id) => tabAria(ids, tab(id), 'agent:a').tabIndex);
    expect(stops).toEqual([-1, 0, -1, -1]);
    expect(tabAria(ids, tab('conversation'), 'gone').tabIndex).toBe(0);
  });

  it('marks the active tab selected', () => {
    expect(tabAria(ids, tab('agent:a'), 'agent:a')).toMatchObject({ role: 'tab', 'aria-selected': true });
    expect(tabAria(ids, tab('agent:b'), 'agent:a')['aria-selected']).toBe(false);
  });

  it('ties a tab to its panel by id when there is an idBase, with ids safe to reference', () => {
    const t = tabAria(ids, tab('survey src'), 'x', 'wf');
    expect(t.id).toBe(tabDomId('wf', 'survey src'));
    expect(t['aria-controls']).toBe(panelDomId('wf', 'survey src'));
    expect(t.id).not.toMatch(/\s/);
    expect(tabAria(ids, tab('a'), 'a')).not.toHaveProperty('aria-controls');
  });

  it('names a tab with a status after its label', () => {
    expect(tabName('Explorer', 'running')).toBe('Explorer, running');
    expect(tabName('Explorer', 'failed')).toBe('Explorer, failed');
    expect(tabAria(ids, tab('x', { label: 'Explorer', status: 'waiting' }), 'x')['aria-label']).toBe('Explorer, waiting');
    expect(tabAria(ids, tab('x', { label: 'Explorer' }), 'x')).not.toHaveProperty('aria-label');
  });
});

/** A Field's label wiring, with the label and children as a Field renders them. */
function fieldMarkup(children: ReactElement | ReactElement[] | string): { html: string; controlId?: string; group: boolean } {
  const b = bindField(children, 'f1');
  return { html: renderToStaticMarkup(createElement('div', null, b.children)), controlId: b.controlId, group: b.group };
}

function NumberLike({ id }: { id?: string }) {
  return createElement('input', { id, type: 'number' });
}
NumberLike.labelable = true;

function Opaque() {
  return createElement('span', null, 'x');
}

describe('bindField', () => {
  it('puts the id on a single input, select or textarea', () => {
    for (const tag of ['input', 'select', 'textarea']) {
      const r = fieldMarkup(createElement(tag));
      expect(r.controlId).toBe('f1');
      expect(r.group).toBe(false);
      expect(r.html).toContain('id="f1"');
    }
  });

  it('keeps an id the control already has', () => {
    const r = fieldMarkup(createElement('input', { id: 'mine' }));
    expect(r.controlId).toBe('mine');
    expect(r.html).toContain('id="mine"');
    expect(r.html).not.toContain('f1');
  });

  it('passes the id to a component that marks itself labelable (NumberInput)', () => {
    const r = fieldMarkup(createElement(NumberLike));
    expect(r.controlId).toBe('f1');
    expect(r.group).toBe(false);
    expect(r.html).toBe('<div><input id="f1" type="number"/></div>');
  });

  it('puts the id on the first control inside a wrapper, and makes the field a group too', () => {
    const r = fieldMarkup(createElement('div', { className: 'browse-row' }, createElement('input'), createElement('button', null, 'Browse…')));
    expect(r.controlId).toBe('f1');
    expect(r.group).toBe(true);
    expect(r.html).toBe('<div><div class="browse-row"><input id="f1"/><button>Browse…</button></div></div>');
  });

  it('finds a labelable component inside a wrapper', () => {
    const r = fieldMarkup(createElement('div', null, createElement(NumberLike), createElement(NumberLike)));
    expect(r.controlId).toBe('f1');
    expect(r.html).toBe('<div><div><input id="f1" type="number"/><input type="number"/></div></div>');
  });

  it('makes a field with several children, or none a label can name, a group', () => {
    const several = fieldMarkup([createElement('input', { key: 'a' }), createElement('input', { key: 'b' })]);
    expect(several.group).toBe(true);
    expect(several.controlId).toBeUndefined();
    expect(several.html).not.toContain('id=');
    const buttons = fieldMarkup(createElement('div', null, createElement('button', null, 'Mon')));
    expect(buttons).toMatchObject({ group: true, controlId: undefined });
    expect(fieldMarkup(createElement(Opaque))).toMatchObject({ group: true, controlId: undefined });
    expect(fieldMarkup('text')).toMatchObject({ group: true, controlId: undefined });
  });

  it('calls a field one line high only when a single one-line control is all it shows', () => {
    const oneLine = (children: ReactNode) => bindField(children, 'f1').oneLine;
    for (const tag of ['input', 'select']) expect(oneLine(createElement(tag)), tag).toBe(true);
    expect(oneLine(createElement(NumberLike))).toBe(true);
    // InputSuffix: a wrapper around the control and nothing else.
    expect(oneLine(createElement('div', null, createElement('input')))).toBe(true);
    // A warning that isn't showing changes nothing; one that is takes a line of its own.
    expect(oneLine([createElement('input', { key: 'a' }), false])).toBe(true);
    expect(oneLine([createElement('input', { key: 'a' }), createElement('p', { key: 'b' })])).toBe(false);
    expect(oneLine(createElement('textarea'))).toBe(false);
    expect(oneLine(createElement('div', null, createElement('input'), createElement('button', null, 'Browse…')))).toBe(false);
    expect(oneLine(createElement(Opaque))).toBe(false);
    expect(oneLine('text')).toBe(false);
  });
});

describe('textOptions', () => {
  const OFF = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false };

  it('leaves an ordinary text box to the keyboard', () => {
    expect(textOptions({})).toEqual({ className: undefined });
    expect(textOptions({}, 'mine')).toEqual({ className: 'mine' });
  });

  it('stops the keyboard changing code, which is monospace, and verbatim text, which is not', () => {
    expect(textOptions({ code: true }, 'json-editor')).toEqual({ ...OFF, className: 'mono json-editor' });
    expect(textOptions({ verbatim: true })).toEqual({ ...OFF, className: undefined });
  });
});

describe('resultSummary', () => {
  it('picks summary, then paragraph, then the longest string field of a JSON result', () => {
    expect(resultSummary(JSON.stringify({ summary: 'Short summary.', paragraph: 'A much longer paragraph than the summary is.' }))).toBe('Short summary.');
    expect(resultSummary(JSON.stringify({ files: ['a'], paragraph: 'The webapp has six modules.', note: 'x' }))).toBe('The webapp has six modules.');
    expect(resultSummary(JSON.stringify({ a: 'one', b: 'the longest one', c: 3 }))).toBe('the longest one');
  });

  it('flattens a multi-line field to one line', () => {
    expect(resultSummary(JSON.stringify({ summary: 'Line one.\n\n  Line two.' }))).toBe('Line one. Line two.');
  });

  it('uses the first line of text that is not a JSON object', () => {
    expect(resultSummary('First line\nsecond line')).toBe('First line');
    expect(resultSummary('\n\n  Indented first\nrest')).toBe('Indented first');
  });

  it('keeps indented JSON with no string field, or cut off, on one line', () => {
    expect(resultSummary('{\n  "n": 1,\n  "list": [1, 2]\n}')).toBe('{ "n": 1, "list": [1, 2] }');
    expect(resultSummary('{\n  "files": [\n    "/a/b",')).toBe('{ "files": [ "/a/b",');
    expect(resultSummary('[\n  1,\n  2\n]')).toBe('[ 1, 2 ]');
  });
});

describe('resultParts', () => {
  it('splits a JSON object into its main text and the other fields', () => {
    const text = JSON.stringify({ files: ['a', 'b'], paragraph: 'The paragraph.', count: 2 });
    expect(resultParts(text)).toEqual({
      kind: 'object',
      main: { key: 'paragraph', text: 'The paragraph.' },
      rest: [
        ['files', ['a', 'b']],
        ['count', 2],
      ],
    });
  });

  it('has no main text when no field is a string', () => {
    expect(resultParts('{"n": 1}')).toEqual({ kind: 'object', rest: [['n', 1]] });
  });

  it('treats anything that is not a JSON object as text', () => {
    expect(resultParts('plain words')).toEqual({ kind: 'text', text: 'plain words' });
    expect(resultParts('[1, 2]')).toEqual({ kind: 'text', text: '[1, 2]' });
    expect(resultParts('{ cut off')).toEqual({ kind: 'text', text: '{ cut off' });
  });
});
