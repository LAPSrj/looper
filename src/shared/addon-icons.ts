/**
 * An addon's own icon, read from SVG text: only shapes and their geometry are
 * kept, so an icon can't run or load anything. The renderer draws the result as
 * elements (iconNode in components/icons.tsx), never as HTML.
 */

export const SHAPE_TAGS = ['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'g'] as const;
export type ShapeTag = (typeof SHAPE_TAGS)[number];

/** A shape: its tag, its attributes, and with `g` what's inside it. */
export type IconShape = [ShapeTag, Record<string, string>, IconShape[]?];

export interface IconDrawing {
  /** The square viewBox's size. */
  box: number;
  fill: string;
  stroke: string;
  shapes: IconShape[];
}

/** The longest SVG text an icon can be: it goes to every window with its command. */
export const MAX_ICON_SVG = 8192;

/** What a surface's `icon` starts with when the rest is a drawing instead of an ICONS key. */
export const DRAWN_ICON = 'svg:';
export const drawnIcon = (d: IconDrawing): string => `${DRAWN_ICON}${JSON.stringify(d)}`;

const NUMBERS = /^[-+0-9.eE\s,%]*$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/;
const TRANSFORM = /^(\s*(matrix|translate|scale|rotate|skewX|skewY)\([-+0-9.eE\s,]*\)\s*,?)*$/;
const PAINT = /^(none|currentColor)$/;
const FILL_RULE = /^(nonzero|evenodd)$/;

const GEOMETRY: Record<ShapeTag, readonly string[]> = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  g: [],
};

/** Left out without complaint: they don't change the shape, and Looper sets the stroke's look itself. */
const IGNORED = /^(xmlns(:.*)?|version|class|id|width|height|stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|aria-.*|role|data-.*)$/;
/** These only describe the file: what's inside them is left out. */
const SKIPPED_TAGS = new Set(['title', 'desc', 'metadata']);

const isShape = (tag: string): tag is ShapeTag => (SHAPE_TAGS as readonly string[]).includes(tag);

function attrError(tag: string, name: string, value: string): string | undefined {
  if (name === 'fill' || name === 'stroke') return PAINT.test(value) ? undefined : `${name}="${value}" isn't allowed: use "none" or "currentColor"`;
  if (name === 'fill-rule' || name === 'clip-rule') return FILL_RULE.test(value) ? undefined : `${name}="${value}" isn't allowed`;
  if (name === 'transform') return TRANSFORM.test(value) ? undefined : `transform="${value}" isn't allowed`;
  if (name === 'd' && GEOMETRY[tag as ShapeTag]?.includes('d')) return PATH_DATA.test(value) ? undefined : 'its path data has other characters';
  if (GEOMETRY[tag as ShapeTag]?.includes(name)) return NUMBERS.test(value) ? undefined : `${name}="${value}" isn't a number`;
  return `<${tag}> can't have "${name}"`;
}

const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAG_END = /\s*(\/?)>/y;

/** A tag's attributes from `at` on; an error when something else is there. */
function readAttributes(text: string, at: number): { attrs: Record<string, string>; end: number; selfClosed: boolean } | { error: string } {
  const attrs: Record<string, string> = {};
  let pos = at;
  for (;;) {
    TAG_END.lastIndex = pos;
    const end = TAG_END.exec(text);
    if (end) return { attrs, end: TAG_END.lastIndex, selfClosed: end[1] === '/' };
    ATTRIBUTE.lastIndex = pos;
    const m = ATTRIBUTE.exec(text);
    if (!m) return { error: 'it isn’t well-formed SVG' };
    attrs[m[1]] = m[2] ?? m[3];
    pos = ATTRIBUTE.lastIndex;
  }
}

/** The drawing in SVG text, or what's wrong with it. */
export function parseSvgIcon(text: string): { ok: true; drawing: IconDrawing } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (text.length > MAX_ICON_SVG) return fail(`it's over ${MAX_ICON_SVG} characters`);
  let drawing: IconDrawing | undefined;
  /** The open elements' children, innermost last; the root's is the drawing's. */
  const stack: { tag: string; shapes: IconShape[] }[] = [];
  let skipping: string | undefined;
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf('<', pos);
    const between = text.slice(pos, open < 0 ? text.length : open);
    if (between.trim() && !skipping) return fail('it has text outside its shapes');
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open);
      if (end < 0) return fail('it isn’t well-formed SVG');
      pos = end + 3;
      continue;
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open);
      if (end < 0) return fail('it isn’t well-formed SVG');
      pos = end + 2;
      continue;
    }
    if (text.startsWith('<!', open)) return fail('it has a declaration, which isn’t allowed');
    if (text[open + 1] === '/') {
      const end = text.indexOf('>', open);
      if (end < 0) return fail('it isn’t well-formed SVG');
      const name = text.slice(open + 2, end).trim();
      if (skipping) {
        if (name === skipping) skipping = undefined;
      } else {
        const top = stack.pop();
        if (!top || top.tag !== name) return fail('it isn’t well-formed SVG');
      }
      pos = end + 1;
      continue;
    }
    const tagMatch = /^[^\s/>]+/.exec(text.slice(open + 1, open + 40));
    if (!tagMatch) return fail('it isn’t well-formed SVG');
    const tag = tagMatch[0];
    const read = readAttributes(text, open + 1 + tag.length);
    if ('error' in read) return fail(read.error);
    pos = read.end;
    if (skipping) continue;
    if (SKIPPED_TAGS.has(tag)) {
      if (!read.selfClosed) skipping = tag;
      continue;
    }
    if (!drawing) {
      if (tag !== 'svg') return fail('it doesn’t start with <svg>');
      const box = /^\s*0[\s,]+0[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*$/.exec(read.attrs.viewBox ?? '');
      if (!box || box[1] !== box[2] || !(Number(box[1]) > 0)) return fail('it needs a square viewBox that starts at 0 0, such as "0 0 24 24"');
      const { fill, stroke, viewBox: _viewBox, ...rest } = read.attrs;
      for (const [name, value] of Object.entries({ ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}) })) {
        const error = attrError('svg', name, value);
        if (error) return fail(error);
      }
      for (const name of Object.keys(rest)) if (!IGNORED.test(name)) return fail(`<svg> can't have "${name}"`);
      // As in SVG itself, a file that doesn't say is filled and not stroked; black is the icon's color here.
      drawing = { box: Number(box[1]), fill: fill ?? 'currentColor', stroke: stroke ?? 'none', shapes: [] };
      if (read.selfClosed) break;
      stack.push({ tag, shapes: drawing.shapes });
      continue;
    }
    if (!isShape(tag)) return fail(`<${tag}> isn't allowed: use only ${SHAPE_TAGS.join(', ')}`);
    const parent = stack[stack.length - 1];
    if (!parent) return fail('it has shapes outside <svg>');
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(read.attrs)) {
      if (IGNORED.test(name) && !GEOMETRY[tag].includes(name)) continue;
      const error = attrError(tag, name, value);
      if (error) return fail(error);
      attrs[name] = value;
    }
    const children: IconShape[] = [];
    parent.shapes.push(tag === 'g' ? [tag, attrs, children] : [tag, attrs]);
    if (!read.selfClosed) stack.push({ tag, shapes: children });
  }
  if (!drawing) return fail('it doesn’t start with <svg>');
  if (stack.length) return fail('it isn’t well-formed SVG');
  if (!drawing.shapes.length) return fail('it has no shapes');
  return { ok: true, drawing };
}
