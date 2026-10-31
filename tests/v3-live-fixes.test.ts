import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.join(__dirname, '..', 'src', 'renderer', 'src');
const read = (file: string) => fs.readFileSync(path.join(src, file), 'utf8');

// Static guards for what the V3 live check found (each was a failing axe or hit-test result).
describe('V3 live check fixes', () => {
  it('the iOS segmented control does not clip its 44 pt targets', () => {
    const phone = read('phone.css');
    const start = phone.indexOf(".tabs-segmented,\nhtml.phone-window[data-platform='ios'] .phone-detail > .detail > .tabs {\n  flex: none;");
    expect(start).toBeGreaterThan(0);
    expect(phone.slice(start, phone.indexOf('}', start))).toContain('overflow: visible');
  });

  it('a pane splitter reports its position (a focusable separator needs aria-valuenow)', () => {
    const sidebar = read('components/Sidebar.tsx');
    expect(sidebar).toMatch(/role="separator"[\s\S]{0,400}aria-valuenow=/);
  });

  it('the empty Chats list holds a treeitem (a tree must own one)', () => {
    expect(read('components/SessionList.tsx')).toMatch(/session-empty" role="treeitem" aria-disabled="true"/);
  });

  it('the phone segmented control has one Tab stop and arrow keys, like Tabs', () => {
    const list = read('components/phone/PhoneList.tsx');
    expect(list).toContain('tabKeyTarget(ids, value, e)');
    expect(list).toContain('tabIndex={tabStop(ids, value) === id ? 0 : -1}');
  });

  it('the task JSON editor has an accessible name', () => {
    expect(read('components/TaskEditor.tsx')).toMatch(/<textarea className="json-editor mono" aria-label="Task JSON"/);
  });
});
