import { describe, expect, it } from 'vitest';
import { chatGroupKey, chatGroups, dashboardCards, inChatGroup, listOrder, NO_FOLDER, WAITING_GROUP_KEY, type ChatPlaces, type SessionSummary } from '../src/shared/sessions';

const s = (id: string, projectId: string | undefined, groupName: string, startedAt = 0) => ({ id, projectId, groupName, startedAt }) as SessionSummary;
const ids = (list: SessionSummary[]) => list.map((x) => x.id);

// Two folders (Clients and Clients / Acme), a project in each, one at the top level.
const places: ChatPlaces = {
  projects: [{ id: 'web' }, { id: 'acme', folderId: 'f2' }, { id: 'shop', folderId: 'f1' }],
  folders: [
    { id: 'f1', name: 'Clients' },
    { id: 'f2', name: 'Acme', parentId: 'f1' },
  ],
  layout: { '': ['folder:f1', 'web'], f1: ['folder:f2', 'shop'] },
};
// In the engine's order: by project, then started.
const sessions = [s('a', 'web', 'Web', 1), s('b', 'acme', 'Acme', 2), s('c', 'shop', 'Shop', 3), s('d', undefined, '/tmp', 4), s('e', 'web', 'Web', 5)];

describe('Group Chats By', () => {
  it("groups by project in the engine's order", () => {
    const byProject = [sessions[0], sessions[4], sessions[1], sessions[2], sessions[3]];
    const groups = chatGroups(byProject, 'project', places);
    expect(groups.map((g) => [g.key, g.name, ids(g.items)])).toEqual([
      ['web', 'Web', ['a', 'e']],
      ['acme', 'Acme', ['b']],
      ['shop', 'Shop', ['c']],
      ['/tmp', '/tmp', ['d']],
    ]);
  });

  it("groups by the Projects tab's folder each project is in, in that tab's order, No Folder last", () => {
    const groups = chatGroups(sessions, 'folder', places);
    expect(groups.map((g) => [g.key, g.name, ids(g.items)])).toEqual([
      ['folder:f2', 'Clients / Acme', ['b']],
      ['folder:f1', 'Clients', ['c']],
      ['folder:', NO_FOLDER, ['a', 'e', 'd']],
    ]);
    expect(chatGroupKey(sessions[1], 'folder', places)).toBe('folder:f2');
    expect(inChatGroup(sessions[3], 'folder:', places)).toBe(true);
    expect(inChatGroup(sessions[0], 'web', places)).toBe(true);
    expect(inChatGroup(sessions[0], 'folder:f1', places)).toBe(false);
  });

  it('puts the rows in one group without a header with None, in the dragged order, the others as they started', () => {
    const groups = chatGroups(sessions, 'none', places, ['e', 'gone', 'c']);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('');
    expect(ids(listOrder(groups))).toEqual(['e', 'c', 'a', 'b', 'd']);
    expect(chatGroups([], 'none', places)).toEqual([]);
  });
});

describe('Dashboard Filter', () => {
  const waiting = { ...s('w', 'acme', 'Acme', 6), waiting: { reason: 'permission', text: 'Asks', since: 1 } } as SessionSummary;
  const groups = chatGroups([...sessions, waiting], 'folder', places);
  const filter = { hiddenCards: [] as string[], showHiddenCards: false, cardsListedOnly: false, collapsed: [] as string[], waitingFirst: true };

  it('leaves out the hidden chats unless Show Hidden Chats is on', () => {
    expect(ids(dashboardCards(groups, { ...filter, hiddenCards: ['c', 'gone'] }))).toEqual(['b', 'w', 'a', 'e', 'd']);
    expect(ids(dashboardCards(groups, { ...filter, hiddenCards: ['c'], showHiddenCards: true }))).toHaveLength(6);
  });

  it("with Only Chats Shown in the List, leaves out a closed group's chats, unless they wait in an open Waiting for you", () => {
    const listed = { ...filter, cardsListedOnly: true, collapsed: ['folder:f2', 'folder:'] };
    expect(ids(dashboardCards(groups, listed))).toEqual(['w', 'c']);
    expect(ids(dashboardCards(groups, { ...listed, collapsed: [...listed.collapsed, WAITING_GROUP_KEY] }))).toEqual(['c']);
    expect(ids(dashboardCards(groups, { ...listed, waitingFirst: false }))).toEqual(['c']);
    // Group Chats By None has no group to close.
    expect(dashboardCards(chatGroups(sessions, 'none', places), { ...listed, collapsed: [''] })).toHaveLength(5);
  });
});
