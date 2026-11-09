import type { ChatState } from '@shared/chat';
import type { SessionSummary, UsageLimits } from '@shared/sessions';
import { fmtClock } from '../../format';
import { MINUTE, useNow } from '../../useNow';
import { SETTINGS, SETTING_TITLES, settingDisabled, settingLabels, showSettingMenu } from '../chat-settings';
import { limitFacts, sessionFacts } from '../usage';
import { Group, Row } from './PhoneList';

/** The account's usage limits as an inset grouped list; nothing when the account reports none. */
function AccountLimits({ limits }: { limits: UsageLimits }) {
  const facts = limitFacts(limits, useNow(MINUTE));
  if (facts.length === 0) return null;
  return (
    <Group title="Account Limits">
      {facts.map((f) => (
        <Row key={f.label} title={f.label} value={f.value} valueTone={f.tone} />
      ))}
    </Group>
  );
}

/**
 * The Usage sheet's content: the session's facts (none yet in a new chat), the account's limits, then
 * the chat's harness, model, effort and permission mode as rows that open the
 * same menus the desktop's command bar has.
 */
export function UsagePanel({ summary, chat, limits }: { summary: SessionSummary; chat: ChatState | null; limits: UsageLimits }) {
  const now = useNow(MINUTE);
  const labels = chat ? settingLabels(chat) : null;
  // A chat lists its harness and model under Chat Settings, so they aren't facts too.
  const facts = sessionFacts(
    {
      harness: chat ? undefined : summary.harnessName,
      context: chat?.context ?? summary.context,
      lastReplyAt: summary.lastReplyAt,
      cacheUntil: summary.cacheUntil,
    },
    now,
    fmtClock,
  );
  return (
    <div className="usage-panel">
      {facts.length > 0 && (
        <Group title="Session">
          {facts.map((f) => (
            <Row key={f.label} title={f.label} value={f.value} />
          ))}
        </Group>
      )}
      <AccountLimits limits={limits} />
      {chat && labels && (
        <Group title="Chat Settings">
          {SETTINGS.map((which) =>
            settingDisabled(chat, which) ? (
              <Row key={which} title={SETTING_TITLES[which]} value={labels[which]} tone="muted" />
            ) : (
              <Row key={which} title={SETTING_TITLES[which]} value={labels[which]} chevron onOpen={(row) => showSettingMenu(chat, which, row.getBoundingClientRect())} />
            ),
          )}
        </Group>
      )}
    </div>
  );
}
