// What `npm run ui-check` asserts about a screen, from its DOM. `inspect` runs inside each frame of the phone's page (the page
// and each window's iframe) and returns the failures it finds: { rule, what, measured }. A window under another window draws nothing
// it measures. Sizes are CSS pixels, which are points on iOS and dp on Android.
//
// iOS (ios.md): Navigation bar (Back a 44 x 44 glass circle with a chevron alone, a centered title), Lists (cards 16 from the edges),
// Sheets (a large sheet starts right under the status bar; a grabber only on a sheet with more than one height, and a button). Android (Material 3): Top app bar (a 64 dp bar whose leading icon
// button holds the back arrow), Lists (16 dp leading padding). Both: Back is drawn only in the bar, and commands for what a
// screen shows are its bottom toolbar, not a strip of buttons in its content, and a conversation's message box sits on the
// conversation (on iOS the conversation runs under it to the screen's bottom).

/** The rules, with what each is measured against, for the report. */
export const RULES = {
  'back-size': 'Back is a 44 x 44 button with no text in the bar (ios.md, Navigation bar)',
  'title-centered': "the bar's title is centered within 1 pt when it fits centered; one that doesn't takes the room between the buttons (ios.md, Navigation bar; UIKit)",
  'list-inset': 'a list card is 16 from the edges; on a tablet it is centered and at least 16 (ios.md, Lists; Material 3, Lists: 16 dp)',
  'group-in-card': "a list's group header is its section's title outside the card, never a row inside it (ios.md, Lists: a section title is 9 above its card; Material 3, Lists)",
  'pane-group-mix': "each group of an addon's pane is a list section of its own: its name as the title, only its items in the card (ios.md, Lists)",
  'sheet-top': 'a large sheet starts under the status bar (ios.md, Sheets)',
  'row-one-line':
    "a form row that picks (a path, a pop-up button) spans its card, its label at the leading edge and its value on the same line at the trailing end (ios.md, Lists: a value at the trailing end; kit: Lists, Type=Pop-up)",
  'separator-edge': "a row's hairline runs from its text's start to the card's trailing edge (ios.md, Lists)",
  'segment-cut': "a segmented control's labels show whole (ios.md, Segmented control: short labels, at most five)",
  'title-cut': "the bar's title is cut only when it doesn't fit between the buttons, centered or not (ios.md, Navigation bar)",
  'tabs-cut': "a segmented control or tab strip stays inside the screen (ios.md, Segmented control)",
  'stray-back': 'no element has a *-back class, or starts with a back chevron or arrow, outside the bar',
  'appbar-height': 'the top app bar is 64 dp, and 56 dp in a sheet or full-screen dialog (Material 3, Top app bar; Dialogs, header height)',
  'appbar-back': "Back is the arrow in the top app bar's leading icon button, with no text (Material 3, Top app bar)",
  'segment-type': "a segmented control's labels are 13.33/18 (ios.md, Segmented control)",
  'dialog-width': 'a dialog on an Android tablet is 280 to 560 dp wide (Material 3, Dialogs: container width min 280dp, max 560dp)',
  'grabber-detents': 'a grabber only on a sheet that rests at more than one height (ios.md, Sheets; HIG Sheets: "Include a grabber in a resizable sheet")',
  'grabber-button': "a resizable sheet's grabber is a labeled button, so a tap, VoiceOver or TalkBack moves the sheet to its other height (HIG Sheets: \"tap it to cycle through the detents\")",
  'under-bar':
    "on iOS a page runs under the bar to the screen's top and starts its content below it: only content scrolled up goes under the bar (WWDC25 284: \"extend the scroll view fully under the navigationBar\"; ios.md, Scroll edge effects)",
  'frames-stall': 'the screen keeps drawing: requestAnimationFrame runs at least 5 times in each second sampled (a page whose frames stop takes no taps)',
  'box-under':
    "a conversation's message box sits on the conversation: on iOS the conversation runs to the screen's bottom under it (ios.md, Scroll edge effects: \"A conversation runs to the screen's bottom under its message box, as in Messages\"), and on every phone the color around the box is the conversation's, not a band of the screen's or the sheet's",
  'content-toolbar':
    "commands that act on what a screen shows are its bottom toolbar (BottomToolbar), not a strip of buttons in its content (HIG Tab bars: \"If you need to provide controls that act on elements in the current view, use a Toolbar\"; Material 3 Toolbars: a floating toolbar for \"contextual actions relevant to the body content\")",
};

/** @param {{ os: 'ios' | 'android', tablet: boolean }} where */
export function inspect({ os, tablet }) {
  const failures = [];
  const win = window.frameElement?.closest('.ph-win');
  if (win && !win.classList.contains('top')) return failures;
  const BACKS = String.fromCharCode(8249, 8592);
  const fail = (rule, el, measured) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    failures.push({ rule, what: `<${el.tagName.toLowerCase()} class="${String(el.getAttribute('class') ?? '').slice(0, 60)}"${text ? ` "${text}"` : ''}>`, measured });
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const all = (sel) => [...document.querySelectorAll(sel)].filter(shown);
  // A list card's distance from its scroller's edges: 16 on a phone, centered and at least 16 on a tablet's wider page.
  for (const el of all('.pg-list')) {
    const c = (() => {
      for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
      return document.documentElement;
    })();
    const cb = c === document.documentElement ? { left: 0, right: innerWidth } : c.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = r.left - cb.left;
    const right = cb.right - r.right;
    const ok = tablet ? left >= 15.5 && Math.abs(left - right) <= 1 : Math.abs(left - 16) <= 0.5 && Math.abs(right - 16) <= 0.5;
    if (!ok) fail('list-inset', el, `${Math.round(left * 10) / 10} from the left and ${Math.round(right * 10) / 10} from the right`);
  }
  // A group's header is the section's title, not a row of the card.
  for (const el of all('.pg-list .group-header')) fail('group-in-card', el, 'a group header inside a list card');
  const round = (n) => Math.round(n * 10) / 10;
  /** The top of an element in the top page's coordinates. */
  const topOf = (el) => {
    let y = el.getBoundingClientRect().top;
    for (let w = window; w !== w.top && w.frameElement; w = w.parent) y += w.frameElement.getBoundingClientRect().top;
    return y;
  };

  if (os === 'ios') {
    // A row that picks a path or opens a pop-up button's menu: as wide as its card, its label and its value on one line.
    for (const row of all('.form-group .path-row, .form-group .field-line:has(> .select-control)')) {
      const card = row.closest('.form-group-rows, .form-group') ?? row.parentElement;
      const label = row.querySelector('.field-label');
      const value = row.querySelector('.path-row-value, .select-value');
      if (!card || !label || !value) continue;
      const rr = row.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      const vr = value.getBoundingClientRect();
      const oneLine = Math.abs((lr.top + lr.bottom) / 2 - (vr.top + vr.bottom) / 2) <= 4 && vr.left >= lr.right - 0.5;
      // A row's line is the card's width less a field's 16 of padding on each side, or the whole card for a row that is the field.
      if (!oneLine || rr.width < cr.width - 33) fail('row-one-line', row, `${round(rr.width)} wide in a ${round(cr.width)} card, the value ${oneLine ? 'beside' : 'under'} the label`);
    }
    // Each row's hairline (its ::before) reaches its card's trailing edge.
    for (const row of all('.form-group :is(.field, .checkbox-field), .pg-list .pg-row')) {
      const cs = getComputedStyle(row, '::before');
      if (cs.content === 'none' || cs.content === 'normal' || cs.position !== 'absolute' || parseFloat(cs.height) > 1) continue;
      const right = parseFloat(cs.right) || 0;
      if (right > 0.5) fail('separator-edge', row, `ends ${round(right)} short of the trailing edge`);
    }
    for (const el of all('.ios-bar-row .ios-back')) {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      if (Math.abs(r.width - 44) > 0.5 || Math.abs(r.height - 44) > 0.5 || text) fail('back-size', el, `${round(r.width)}x${round(r.height)}${text ? `, text "${text}"` : ''}`);
    }
    for (const row of all('.ios-bar-row')) {
      const title = row.querySelector('.ios-bar-title');
      if (!title || !shown(title) || !title.textContent.trim()) continue;
      const rowBox = row.getBoundingClientRect();
      const middle = rowBox.left + rowBox.width / 2;
      const lead = row.querySelector('.ios-bar-lead')?.getBoundingClientRect();
      const trail = row.querySelector('.ios-bar-trail')?.getBoundingClientRect();
      const left = lead && lead.width ? lead.right : rowBox.left;
      const right = trail && trail.width ? trail.left : rowBox.right;
      // What the title needs: its text and its side padding (the box is cut, the text isn't).
      const range = document.createRange();
      range.selectNodeContents(title);
      const text = range.getBoundingClientRect();
      const cs = getComputedStyle(title);
      const need = text.width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const cut = title.scrollWidth > title.clientWidth + 1;
      // Centered between equal sides when it fits there; else (UIKit) it takes all the room between the buttons.
      const centeredRoom = 2 * Math.min(middle - left, right - middle);
      const box = title.getBoundingClientRect();
      const center = cut ? box.left + box.width / 2 : text.left + text.width / 2;
      if (need <= centeredRoom && Math.abs(center - middle) > 1) fail('title-centered', title, `${round(center - middle)} pt off center (${round(center)} against ${round(middle)}) though it fits centered (${round(need)} of ${round(centeredRoom)})`);
      if (cut && need <= right - left + 0.5) fail('title-cut', title, `cut at ${round(title.clientWidth)} though the title needs ${round(need)} and ${round(right - left)} are free between the buttons`);
    }
    for (const el of all('.tabs .tab, .tabs > button, .pg-segmented > button')) {
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 0.5 || r.left < -0.5) fail('tabs-cut', el, `${round(r.left)} to ${round(r.right)} on a ${innerWidth} wide screen`);
    }
    for (const el of all('.pg-segmented button')) {
      const cs = getComputedStyle(el);
      if (Math.abs(parseFloat(cs.fontSize) - 13.33) > 0.1 || Math.abs(parseFloat(cs.lineHeight) - 18) > 0.5) fail('segment-type', el, `${cs.fontSize}/${cs.lineHeight}`);
    }
    for (const el of all('.pg-segment-label')) {
      if (el.scrollWidth > el.clientWidth + 1) fail('segment-cut', el, `${round(el.clientWidth)} wide for ${round(el.scrollWidth)} of text`);
    }
    if (!tablet) {
      for (const el of all('.pg-sheet, .ios-own-sheet')) {
        if (el.classList.contains('detent-medium')) continue;
        const y = topOf(el);
        if (y > 0.5) fail('sheet-top', el, `starts ${round(y)} down; the status bar is 0 here`);
      }
    }
  } else {
    for (const card of all('.pres-dialog > .ph-card')) {
      const w = card.getBoundingClientRect().width;
      if (w > 560.5 || w < 279.5) fail('dialog-width', card, `${round(w)} dp wide`);
    }
    for (const row of all('.md-bar-row')) {
      const r = row.getBoundingClientRect();
      const want = row.closest('.md-bar.sheet') ? 56 : 64;
      if (Math.abs(r.height - want) > 0.5) fail('appbar-height', row, `${round(r.height)} dp, not ${want}`);
      const back = row.querySelector('.md-icon-btn[aria-label="Back"]');
      if (back) {
        const text = (back.textContent || '').trim();
        const first = row.querySelector('.md-icon-btn, .md-bar-titles, .md-bar-title');
        if (text || first !== back || !back.querySelector('svg')) fail('appbar-back', back, `${text ? `text "${text}"; ` : ''}${first === back ? 'leading' : 'not leading'}${back.querySelector('svg') ? '' : ', no arrow'}`);
      }
    }
  }
  // A conversation's message box (ConversationWithBox), but a dashboard card's, which keeps its box under its conversation.
  const opaque = (c) => c && c !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(c);
  const behind = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (opaque(c)) return c;
    }
    return null;
  };
  for (const box of all('.chat-composer.phone-composer')) {
    if (box.closest('.overview-card, .overview-chat, .overview-composer')) continue;
    let host = box.parentElement;
    while (host && !host.querySelector('.chat-scroll')) host = host.parentElement;
    const scroll = host?.querySelector('.chat-scroll');
    if (!scroll || !shown(scroll)) continue;
    const b = box.getBoundingClientRect();
    const s = scroll.getBoundingClientRect();
    if (os === 'ios' && s.bottom < b.bottom - 1) fail('box-under', box, `the conversation ends ${round(b.bottom - s.bottom)} pt above the box's bottom, so the box sits under it`);
    const around = behind(box.parentElement);
    const conversation = behind(scroll);
    if (around !== conversation) fail('box-under', box, `${around} around the box, ${conversation} behind the conversation`);
  }
  // A strip of buttons in the content where the bottom toolbar belongs: a Toolbar drawn in place (.toolbar), or three or more
  // icon buttons side by side, outside the bars, the bottom toolbar, tab bars, menus, the message box, cards and list rows.
  const CHROME = '.ios-bar-row, .md-bar-row, .bottom-toolbar, [class*="tabbar"], [role=tablist], [role=menu], [role=menubar], .chat-composer, .overview-composer, .overview-chat, .pg-row, .pg-sheet-handle, .md-fab';
  for (const el of all('.toolbar')) {
    if (!el.closest(CHROME)) fail('content-toolbar', el, `a toolbar strip in the content, ${el.querySelectorAll('button').length} buttons`);
  }
  for (const el of all('div, section, header, footer, nav')) {
    if (el.closest(`${CHROME}, .toolbar`)) continue;
    const icons = [...el.children].filter((c) => c.matches('button, [role=button]') && shown(c) && c.querySelector('svg') && !(c.textContent || '').trim());
    if (icons.length < 3) continue;
    const top = icons[0].getBoundingClientRect().top;
    if (icons.every((b) => Math.abs(b.getBoundingClientRect().top - top) < 4)) fail('content-toolbar', el, `${icons.length} icon buttons in a row in the content`);
  }
  // A grabber belongs to a sheet that says which heights it rests at (data-detents).
  for (const el of all('[class*="grabber"]')) {
    const sheet = el.closest('[data-detents]');
    const heights = sheet ? sheet.getAttribute('data-detents').split(/\s+/).filter(Boolean).length : 1;
    if (os === 'ios' && heights < 2) fail('grabber-detents', el, sheet ? `its sheet rests at ${heights} height` : 'its sheet has one height (no data-detents)');
    const label = (el.getAttribute('aria-label') || '').trim();
    if (heights >= 2 && !(el.matches('button, [role=button]') && label)) fail('grabber-button', el, `a <${el.tagName.toLowerCase()}>${label ? '' : ' without a label'}`);
  }
  // iOS: the frame's bar floats over the page (data-under-bar, --looper-bar-h). With nothing scrolled, no text or control
  // of the page is under it.
  const root = document.documentElement;
  if (os === 'ios' && root.hasAttribute('data-under-bar') && !root.hasAttribute('data-lifted')) {
    const bar = parseFloat(root.style.getPropertyValue('--looper-bar-h')) || 0;
    const content = 'button, input, textarea, select, img, canvas, [role=tab], [role=button]';
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.height <= 0 || box.bottom <= 0.5 || box.top >= bar - 0.5) continue;
      const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (!texts.length && !el.matches(content)) continue;
      // Text is where its lines are, not where its box is (an empty state centered in a column as tall as the screen).
      const r = el.matches(content) ? box : (() => {
        const range = document.createRange();
        range.setStartBefore(texts[0]);
        range.setEndAfter(texts[texts.length - 1]);
        return range.getBoundingClientRect();
      })();
      if (r.height <= 0 || r.bottom <= 0.5 || r.top >= bar - 0.5) continue;
      if (!shown(el) || el.closest('.pg-sheet, [role=dialog]')) continue;
      let scrolled = false;
      for (let p = el.parentElement; p && !scrolled; p = p.parentElement) scrolled = p.scrollTop > 0;
      if (!scrolled) fail('under-bar', el, `${round(r.top)} to ${round(r.bottom)} from the top, under the ${round(bar)} high bar`);
    }
  }
  for (const el of document.querySelectorAll('*')) {
    if (el.closest('.ios-bar-row, .md-bar-row') || !shown(el)) continue;
    const named = [...el.classList].find((c) => /(^|-)back(-|$)/.test(c));
    const word = el.matches('button, a') && BACKS.includes((el.textContent || '').trim()[0] ?? '-');
    if (named || word) fail('stray-back', el, named ? `class "${named}"` : 'its text starts with a back chevron or arrow');
  }
  return failures;
}

/**
 * The fixture addon's pane (fixture-addon/addon.mjs: Passwords, entries named `leandro+<site>…`, three loose `note-` ones),
 * read from the screen: one list section a group, titled with the site, holding only that site's entries, and the loose
 * entries in a section without a title. Run inside each frame; returns the failures of the frames that show the pane.
 */
export function inspectPaneGroups(minGroups) {
  const failures = [];
  const sections = [...document.querySelectorAll('.pg-rows > .pg-group, .pg-scroll > .pg-group')].filter((s) => s.querySelector('.pg-row, .group-header'));
  const titled = sections.filter((s) => s.querySelector(':scope > .pg-group-title'));
  if (!titled.length) return failures;
  const rowsOf = (s) => [...s.querySelectorAll(':scope > .pg-list > .pg-row .pg-row-title')].map((e) => e.textContent.trim());
  for (const s of sections) {
    const title = (s.querySelector(':scope > .pg-group-title .group-header-name') ?? s.querySelector(':scope > .pg-group-title'))?.textContent.trim() ?? '';
    const want = title ? `leandro+${title.split('.')[0]}` : 'note-';
    for (const label of rowsOf(s)) {
      if (!label.startsWith(want)) failures.push({ rule: 'pane-group-mix', what: `<section "${title || 'no title'}">`, measured: `holds "${label}", which isn't ${title ? 'of this group' : 'a loose item'}` });
    }
  }
  const drawn = titled.filter((s) => s.querySelector(':scope > .pg-list')).length;
  if (titled.length < minGroups) failures.push({ rule: 'pane-group-mix', what: 'the pane', measured: `${titled.length} titled sections, the fixture has 22 groups, at least ${minGroups} show` });
  else if (!drawn) failures.push({ rule: 'pane-group-mix', what: 'the pane', measured: 'no group is open' });
  return failures;
}
