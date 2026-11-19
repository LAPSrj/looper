import type { ReactNode } from 'react';
import type { Filed } from '@shared/folders';
import type { TaskEntry } from '../task-tree';
import { Icon } from './Icon';
import { ICONS } from './icons';
import { EmptyState } from './EmptyState';
import { Group, Row } from './phone/PhoneList';

/** A folder row's symbol on a phone. */
export const FOLDER_ICON = (
  <span className="pg-folder-icon">
    <Icon>{ICONS.folder}</Icon>
  </span>
);

/**
 * One folder level of a phone's Tasks or Projects screen, as iOS lists a hierarchy:
 * its folders (the folder's symbol, the count inside and a chevron; a tap opens the
 * folder's own screen) and items in one section.
 */
export function PhoneFolderRows<T extends Filed>({
  entries,
  current,
  onOpenFolder,
  onFolderMenu,
  item,
  empty = 'This folder is empty.',
  onEmptyMenu,
}: {
  entries: TaskEntry<T>[];
  /** What a tablet's detail column shows. */
  current: string | null;
  onOpenFolder: (id: string) => void;
  onFolderMenu: (id: string) => void;
  item: (t: T) => ReactNode;
  empty?: string;
  onEmptyMenu?: () => void;
}) {
  return (
    <Group>
      {entries.length === 0 ? (
        <EmptyState at="section" onMenu={onEmptyMenu}>
          {empty}
        </EmptyState>
      ) : (
        entries.map((e) =>
          e.kind === 'folder' ? (
            <Row
              key={`folder-${e.folder.id}`}
              lead={FOLDER_ICON}
              title={e.folder.name}
              value={e.count}
              chevron
              selected={e.folder.id === current}
              onOpen={() => onOpenFolder(e.folder.id)}
              onMenu={() => onFolderMenu(e.folder.id)}
            />
          ) : (
            item(e.task)
          ),
        )
      )}
    </Group>
  );
}

/** A phone's list screen; at the top level (`top`), a long press between its rows shows the list's menu. */
export function PhoneListScreen({ top, onMenu, children }: { top: boolean; onMenu: () => void; children: ReactNode }) {
  return (
    <div
      className="pg-scroll"
      onContextMenu={(e) => {
        if (!top || (e.target as HTMLElement).closest('.pg-row, .pg-group-title, .pg-segmented, .pg-overview')) return;
        e.preventDefault();
        onMenu();
      }}
    >
      {children}
    </div>
  );
}
