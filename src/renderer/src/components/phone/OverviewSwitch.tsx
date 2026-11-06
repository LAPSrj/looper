import { useState, type ReactNode } from 'react';
import { Segmented } from './PhoneList';

export type OverviewChoice = 'list' | 'overview';

/**
 * A tab's list and its Overview on a phone: the switch between them (iOS's
 * segmented control, Material's tabs), then the one chosen. `show` shows one
 * alone, with no switch (a tablet's columns have room for both). Pass `value`
 * and `onChange` when the choice has to outlive this component.
 */
export function OverviewSwitch({
  listLabel,
  list,
  overview,
  show,
  value,
  onChange,
}: {
  listLabel: string;
  list: ReactNode;
  overview: ReactNode;
  show?: OverviewChoice;
  value?: OverviewChoice;
  onChange?: (v: OverviewChoice) => void;
}) {
  const [own, setOwn] = useState<OverviewChoice>('list');
  const picked = value ?? own;
  const shown = show ?? picked;
  return (
    <>
      {!show && (
        <div className="pg-segmented-wrap">
          <Segmented
            items={[
              ['list', listLabel],
              ['overview', 'Overview'],
            ]}
            value={picked}
            onChange={onChange ?? setOwn}
            label="Show"
          />
        </div>
      )}
      {shown === 'list' ? list : overview}
    </>
  );
}
