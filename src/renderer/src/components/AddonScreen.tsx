import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AddonButton, AddonEventKind, AddonField, AddonListRow, AddonNode, AddonProp, AddonScreen, AddonValue } from '@shared/addons';
import { ADDON_WINDOW_VIEWS } from '@shared/commands/build';
import type { AddonContext, CommandContext } from '@shared/commands/context';
import { DetailView } from './DetailView';
import { CommandBar } from './Toolbar';
import { useCommandMenu, useCommandState } from './useCommands';
import { PathField } from './form-blocks';
import { useDialogKeys } from './hooks';
import { Markdown } from './Markdown';
import { PropertyList, type Property } from './PropertyList';
import { AddonListDetail } from './AddonListDetail';
import { emptyValue, fieldRuns, fieldsOf, fillsScreen, isEmpty, isMissing, mergeValues, redrawnProblems, propsOf, refreshes, toggleChecked, type Values } from './addon-screen-model';
import { DiffPane } from './DiffPane';
import { ListActions, ListButton, SelectList } from './SelectList';
import { EmptyState } from './EmptyState';
import { Section } from './Section';
import { CheckboxField, CheckboxGroup, Field, FieldRow, FormGroup, InfoBar, InputRow, InputSuffix, MainInstruction, NumberInput, SelectInput, TabBar, TextArea, TextInput } from './ui';
import { WindowActions } from './WindowActions';
import { reportError } from '../report-error';
import { useAddonList } from '../live-state';
import { AddonNotRunning } from './AddonNotRunning';
import { isPhone } from '../web/page-nav';

type Value = AddonValue;

const isList = (n: AddonNode) => n.type === 'field' && n.input === 'list';

const SECRET_MASK = '••••••••';
/** A new screen slower than this to draw goes to the engine log. */
const SLOW_DRAW_MS = 500;

/** What a screen tells its window, for the commands placed on it (CommandContext `addon.screen`). */
export type AddonScreenReport = NonNullable<AddonContext['screen']>;

/** A screen the addon couldn't draw: the tab's own state when the addon isn't running (Restart), else why, with Try Again. */
function ScreenFailed({ addonId, addonName, error, retry }: { addonId: string; addonName: string; error: string; retry: () => void }) {
  const addon = useAddonList().addons.find((a) => a.id === addonId);
  if (addon && addon.status !== 'running') return <AddonNotRunning addon={addon} />;
  return (
    <EmptyState level="error" title={`${addonName} couldn't show this screen`} action={<button className="btn" onClick={retry}>Try Again</button>}>
      {error}
    </EmptyState>
  );
}

/**
 * The screen's property lists share one label column, as wide as the widest label on the screen, so their values
 * line up from one section to the next (--props-label, which `.addon-screen .props` reads). It adds no box of its own.
 */
function SharedLabels({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Each list's own column is its widest label's width, so measuring them as they are gives the widest on the screen.
    el.style.removeProperty('--props-label');
    const labels = el.querySelectorAll('.props > dt');
    if (labels.length < 2) return;
    let widest = 0;
    for (const dt of labels) widest = Math.max(widest, dt.getBoundingClientRect().width);
    if (widest > 0) el.style.setProperty('--props-label', `${Math.ceil(widest)}px`);
  });
  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

/**
 * An addon's screen, drawn from the nodes it sent: in the main window's
 * detail area (`main`), as the whole of an addon window (`window`, with its
 * footer as the window's Save | Cancel | Apply), or as its body alone inside
 * another view (`inline`: a tool call's result on the Now tab), or filling a
 * place without a title (`fill`: a project's tab, a list's detail). It draws no
 * toolbar or menus of its own: it reports its state (`onScreen`), and its
 * window builds them from the addon's commands, as it does Looper's.
 */
export function AddonScreenView({
  addonId,
  addonName,
  view,
  params,
  mode,
  narrow = false,
  onScreen,
  toolbar,
}: {
  addonId: string;
  addonName: string;
  view: string;
  params: Record<string, unknown>;
  mode: 'main' | 'window' | 'inline' | 'fill';
  /** A narrow place (the Sessions window's activity pane), or a list's detail: a list stacks over its detail. */
  narrow?: boolean;
  /** The screen showing and its commands' state, or null once it's gone. */
  onScreen?: (screen: AddonScreenReport | null) => void;
  /** `window`: the window's toolbar, at its top. */
  toolbar?: ReactNode;
}) {
  const [screen, setScreen] = useState<AddonScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  // Problems with what was typed, by field id (the event answer's `errors`).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const problemsKey = Object.keys(problems).join('\n');
  // The first field with a problem gets the focus, its text selected (Windows' user input errors).
  useEffect(() => {
    if (!problemsKey) return;
    const control = pageRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[aria-invalid="true"]');
    control?.focus();
    if (control && 'select' in control && control.type !== 'checkbox') control.select();
  }, [problemsKey]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const paramsKey = JSON.stringify(params);
  const source = useRef({ view, params });
  source.current = { view, params };

  // The addon may answer out of order: only the latest load's reply is shown.
  const latestLoad = useRef(0);
  const load = useCallback(() => {
    const n = ++latestLoad.current;
    void window.looper.addons
      .render(addonId, view, JSON.parse(paramsKey) as Record<string, unknown>)
      .then((s) => {
        if (n !== latestLoad.current) return;
        setScreen(s);
        setError(null);
        setValues((v) => mergeValues(v, fieldsOf(s.body)));
        // An event's answer replaces the problems; a redraw (the addon refreshing after an action) keeps them.
        setProblems((prev) => redrawnProblems(prev, fieldsOf(s.body)));
      })
      .catch((e: Error) => {
        if (n === latestLoad.current) setError(e.message);
      });
  }, [addonId, view, paramsKey]);

  // When a new screen was asked for, until it's drawn: a slow one is logged.
  const asked = useRef<{ at: number; addonId: string; view: string } | null>(null);
  // The selected tab of each tabs node, by its id: kept across redraws of the same screen.
  const [tabSel, setTabSel] = useState<Record<string, string>>({});
  // The row picked in each listDetail node, by its id: kept across redraws too (null: a phone went back to the list).
  const [listSel, setListSel] = useState<Record<string, string | null>>({});
  // A phone shows a list's detail over the screen: the screen's other parts make way.
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    setScreen(null);
    setError(null);
    setValues({});
    setProblems({});
    setRevealed({});
    setTabSel({});
    setListSel({});
    asked.current = { at: performance.now(), addonId, view };
    load();
  }, [load, addonId, view]);

  useEffect(() => {
    if (!screen && !error) return;
    const a = asked.current;
    asked.current = null;
    if (!screen || !a) return;
    const ms = performance.now() - a.at;
    if (ms > SLOW_DRAW_MS) window.looper.addons.reportSlowDraw(a.addonId, a.view, ms);
  }, [screen, error]);

  useEffect(
    () =>
      window.looper.addons.onEvent((e) => {
        // A redraw the addon asks for follows a change: a revealed secret may be stale.
        if (e.type === 'refresh' && e.addonId === addonId && refreshes(e.only, { view })) {
          setRevealed({});
          load();
        } else if (e.type === 'addons' && e.addons.some((a) => a.id === addonId && a.status === 'running')) load();
      }),
    [addonId, view, load],
  );

  useEffect(() => {
    if (!screen?.refreshSec) return;
    const t = setTimeout(load, screen.refreshSec * 1000);
    return () => clearTimeout(t);
  }, [screen, load]);

  const send = async (kind: AddonEventKind, id: string, confirm?: string, changed?: Values, item?: string) => {
    const { view: v, params: p } = source.current;
    setBusy(true);
    try {
      const r = await window.looper.addons.event(addonId, { source: { view: v, params: p }, kind, id, ...(item !== undefined ? { item } : {}), values: { ...values, ...changed } }, confirm);
      if (r.values) setValues((prev) => ({ ...prev, ...r.values }));
      if (kind !== 'change') setProblems(r.errors ?? {});
      if (kind === 'reveal' && r.value !== undefined) setRevealed((m) => ({ ...m, [id]: r.value! }));
    } finally {
      setBusy(false);
    }
  };

  // The screen's passwords and other secrets: its window's Show command reveals them all, and hides them again.
  const secretProps = screen ? propsOf(screen.body).filter((p) => p.secret) : [];
  const secretIds = [...new Set(secretProps.map((p) => p.secret!))];
  const secretLabels = [...new Set(secretProps.map((p) => p.label))];
  const secretsShown = secretIds.length > 0 && secretIds.every((id) => revealed[id] !== undefined);
  const toggleSecrets = () => {
    if (secretsShown) setRevealed({});
    else for (const id of secretIds) if (revealed[id] === undefined) void send('reveal', id);
  };
  const secrets = secretIds.length ? { label: secretLabels.length === 1 ? secretLabels[0] : 'Secrets', shown: secretsShown } : null;

  // The commands placed on the screen reach it through its window, with the fields' values as they are then.
  const sendRef = useRef(send);
  sendRef.current = send;
  const toggleRef = useRef(toggleSecrets);
  toggleRef.current = toggleSecrets;
  const reportRef = useRef(onScreen);
  reportRef.current = onScreen;
  const commandState = screen?.commands;
  const stateKey = JSON.stringify(commandState ?? null);
  const status = screen?.status;
  const statusKey = JSON.stringify(status ?? null);
  const secretsKey = JSON.stringify(secrets);
  const shown = !!screen;
  useEffect(() => {
    if (!shown) return;
    reportRef.current?.({
      view,
      state: commandState,
      run: (id, confirm) => void sendRef.current('command', id, confirm),
      ...(secrets ? { secrets: { ...secrets, toggle: () => toggleRef.current() } } : {}),
      ...(status ? { status } : {}),
    });
  }, [view, stateKey, secretsKey, statusKey, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => reportRef.current?.(null), []);

  const fields = screen ? fieldsOf(screen.body) : [];
  const missing = fields.some((f) => isMissing(f, values[f.id]));
  const footer = mode === 'window' ? screen?.body.find((n) => n.type === 'footer') : undefined;

  type TabsNode = Extract<AddonNode, { type: 'tabs' }>;
  /** A part that fills its place, or tabs one of whose pages has one. */
  const fills = (n: AddonNode) => fillsScreen(n) || (n.type === 'tabs' && n.items.some((t) => t.body.some(fillsScreen)));
  // A filling part takes the room its window, tab or detail has; an inline screen (a tool call's result) flows.
  const filling = mode !== 'inline' && !!screen?.body.some(fills);
  const activeTab = (n: TabsNode) => (n.items.some((t) => t.id === tabSel[n.id]) ? tabSel[n.id] : n.items[0].id);
  const selectTab = (n: TabsNode) => (id: string) => setTabSel((m) => ({ ...m, [n.id]: id }));
  // A window's top-level tabs go across the top of the window, as in Looper's own editors.
  const windowTabs = mode === 'window' ? (screen?.body.find((n) => n.type === 'tabs') as TabsNode | undefined) : undefined;

  // A desktop window's page that scrolls is one the manifest made too small: the Engine Log says the height it needs, once per tab.
  const pageRef = useRef<HTMLDivElement>(null);
  const overflowSeen = useRef(new Set<string>());
  const shownTab = windowTabs ? activeTab(windowTabs) : '';
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (isPhone || mode !== 'window' || !screen || !page) return;
    const over = page.scrollHeight - page.clientHeight;
    const key = `${view}\n${shownTab}`;
    if (over <= 1 || overflowSeen.current.has(key)) return;
    overflowSeen.current.add(key);
    window.looper.addons.reportOverflow(addonId, view, shownTab, document.documentElement.clientHeight + over);
  }, [screen, shownTab, addonId, view, mode]);

  useDialogKeys({
    tabs: windowTabs?.items.map((t) => t.id),
    tab: windowTabs ? activeTab(windowTabs) : undefined,
    onTab: windowTabs ? selectTab(windowTabs) : undefined,
  });

  /** A button that can't be used now: turned off, waiting for an answer, or one of the fields it needs is empty. */
  const off = (b: AddonButton) => !!b.disabled || busy || !!b.requires?.some((id) => isEmpty(values[id]));

  const button = (b: AddonButton) => (
    <button
      key={b.id}
      className={`btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`}
      disabled={off(b)}
      onClick={() => void send('click', b.id, b.confirm)}
    >
      {b.label}
    </button>
  );

  /** A row of the screen's buttons: Looper's button row on the desktop, command rows on a phone. */
  const buttonRow = (key: number, items: AddonButton[]) => (
    <ListActions key={key}>
      {items.map((b) => (
        <ListButton key={b.id} primary={b.primary} danger={b.danger} disabled={off(b)} onClick={() => void send('click', b.id, b.confirm)}>
          {b.label}
        </ListButton>
      ))}
    </ListActions>
  );

  /** A field's problem goes once what's in it changes. */
  const clearProblem = (id: string) =>
    setProblems((m) => {
      if (!(id in m)) return m;
      const { [id]: _gone, ...rest } = m;
      return rest;
    });
  const setValue = (id: string, v: Value) => {
    setValues((m) => ({ ...m, [id]: v }));
    clearProblem(id);
  };

  const field = (f: AddonField) => {
    const v = values[f.id] ?? emptyValue(f);
    const text = (type: string) => (
      <TextInput
        type={type}
        value={String(v)}
        placeholder={f.placeholder}
        autoFocus={f.autofocus}
        onChange={(e) => setValue(f.id, e.target.value)}
      />
    );
    switch (f.input) {
      case 'checkbox':
        return (
          <CheckboxField key={f.id} label={f.label} checked={v === true} autoFocus={f.autofocus} onChange={(on) => setValue(f.id, on)} />
        );
      case 'textarea':
        return (
          <Field key={f.id} label={f.label} error={problems[f.id]}>
            <TextArea
              rows={5}
              value={String(v)}
              placeholder={f.placeholder}
              autoFocus={f.autofocus}
              onChange={(e) => setValue(f.id, e.target.value)}
            />
          </Field>
        );
      case 'file':
      case 'folder': {
        const input = f.input;
        return (
          <PathField
            key={f.id}
            label={f.label}
            error={problems[f.id]}
            value={String(v)}
            placeholder={f.placeholder}
            autoFocus={f.autofocus}
            onChange={(p) => setValue(f.id, p)}
            onBrowse={() =>
              void window.looper.addons.pickPath(addonId, input, f.accept).then((p) => {
                if (p) setValue(f.id, p);
              })
            }
          />
        );
      }
      case 'select':
        return (
          <Field key={f.id} label={f.label} error={problems[f.id]} help={f.options?.find((o) => o.value === String(v))?.description}>
            <SelectInput
              value={String(v)}
              autoFocus={f.autofocus}
              onChange={(e) => {
                setValue(f.id, e.target.value);
                if (f.change) void send('change', f.id, undefined, { [f.id]: e.target.value });
              }}
            >
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        );
      case 'list': {
        const options = f.options ?? [];
        const selected = options.find((o) => o.value === v);
        const rowButtons = f.readOnly ? [] : (f.buttons ?? []);
        const act = (b: AddonButton, value: string) => void send('click', b.id, b.confirm, { [f.id]: value });
        return (
          <Fragment key={f.id}>
            <SelectList
              items={options}
              label={f.label}
              error={problems[f.id]}
              title={f.label}
              idPrefix={`addon-${f.id}`}
              selectedKey={f.readOnly ? null : (selected?.value ?? null)}
              itemKey={(o) => o.value}
              itemName={(o) => o.label}
              itemSub={(o) => o.description}
              empty={f.placeholder}
              autoFocus={f.autofocus}
              onSelect={f.readOnly ? undefined : (o) => setValue(f.id, o.value)}
              menu={
                rowButtons.length
                  ? (o) =>
                      rowButtons.map((b) => ({
                        label: b.label,
                        enabled: !b.disabled && !busy,
                        ...(b.danger ? { destructive: true as const } : {}),
                        run: () => {
                          setValue(f.id, o.value);
                          act(b, o.value);
                        },
                      }))
                  : undefined
              }
            />
            {rowButtons.length > 0 && (
              <ListActions>
                {rowButtons.map((b) => (
                  <ListButton key={b.id} row danger={b.danger} disabled={!selected || b.disabled || busy} onClick={() => selected && act(b, selected.value)}>
                    {b.label}
                  </ListButton>
                ))}
              </ListActions>
            )}
          </Fragment>
        );
      }
      case 'checklist':
        return (
          <CheckboxGroup
            key={f.id}
            label={f.label}
            options={f.options ?? []}
            checked={Array.isArray(v) ? v : []}
            error={problems[f.id]}
            autoFocus={f.autofocus}
            onChange={(value, on) => {
              setValues((m) => ({ ...m, [f.id]: toggleChecked(f, m[f.id], value, on) }));
              clearProblem(f.id);
            }}
          />
        );
      case 'number':
        return (
          <Field key={f.id} label={f.label} error={problems[f.id]}>
            <NumberInput suffix={f.suffix} value={Number(v) || 0} autoFocus={f.autofocus} onChange={(n) => setValue(f.id, n)} />
          </Field>
        );
      default:
        return (
          <Field key={f.id} label={f.label} error={problems[f.id]}>
            {f.suffix ? <InputSuffix suffix={f.suffix}>{text(f.input)}</InputSuffix> : text(f.input)}
          </Field>
        );
    }
  };

  // A screen in a window with a toolbar: Show is the window's command, and a value with Copy is a read-only text box.
  const boxed = !isPhone && mode !== 'inline';
  const prop = (p: AddonProp): Property => {
    const secret = p.secret;
    const shown = secret ? revealed[secret] : undefined;
    const copy = secret ? () => void send('copy', secret) : p.copy && p.value ? () => void navigator.clipboard.writeText(p.value!) : null;
    if (boxed && copy) {
      return {
        label: p.label,
        className: 'addon-prop-box',
        value: (
          <InputRow>
            <TextInput readOnly code={p.mono || !!secret} aria-label={p.label} value={secret ? (shown ?? SECRET_MASK) : (p.value ?? '')} />
            <button className="btn" disabled={busy} onClick={copy}>
              Copy
            </button>
          </InputRow>
        ),
        note: p.note,
      };
    }
    // A value with nothing beside it is the row's text itself.
    if (!secret && !(p.copy && p.value) && !p.note) return { label: p.label, value: p.value, className: `addon-prop-text${p.mono ? ' mono' : ''}` };
    return {
      label: p.label,
      value: (
        <>
          {/* A secret is monospace shown or hidden, so revealing it never moves the row. */}
          <span className={`addon-prop-value${p.mono || secret ? ' mono' : ''}`}>{secret ? (shown ?? SECRET_MASK) : p.value}</span>
          {secret && (
            <span className="addon-prop-actions">
              <button className="btn" disabled={busy} onClick={() => void send('copy', secret)}>
                Copy
              </button>
              {/* Showing the characters is a state, and the Windows guidelines keep command buttons for actions. */}
              <CheckboxField
                className="addon-reveal"
                label={`Show ${p.label.toLowerCase()}`}
                checked={shown !== undefined}
                disabled={busy}
                onChange={(on) =>
                  on
                    ? void send('reveal', secret)
                    : setRevealed((m) => {
                        const { [secret]: _, ...rest } = m;
                        return rest;
                      })
                }
              />
            </span>
          )}
          {!secret && p.copy && p.value && (
            <span className="addon-prop-actions">
              <button className="btn" onClick={() => void navigator.clipboard.writeText(p.value!)}>
                Copy
              </button>
            </span>
          )}
          {/* After the buttons, so a note whose length changes (a countdown) never moves them. */}
          {p.note && <span className="addon-prop-note muted">{p.note}</span>}
        </>
      ),
    };
  };

  const node = (n: AddonNode, i: number) => {
    switch (n.type) {
      case 'props':
        return <PropertyList key={i} items={n.items.map(prop)} />;
      case 'text':
        return (
          <p key={i} className={`addon-text${n.muted ? ' muted' : ''}`}>
            {n.text}
          </p>
        );
      case 'markdown':
        return (
          <div key={i} className="addon-markdown">
            <Markdown text={n.text} />
          </div>
        );
      case 'infobar':
        return (
          <InfoBar
            key={i}
            title={n.title}
            message={n.message}
            level={n.level}
            action={n.button ? button(n.button) : undefined}
          />
        );
      case 'empty':
        return (
          <EmptyState key={i} at="inline" level={n.level} action={n.button ? button(n.button) : undefined}>
            {n.text}
          </EmptyState>
        );
      case 'buttons':
        return buttonRow(i, n.items);
      case 'field':
        return field(n);
      case 'row':
        return <FieldRow key={i}>{n.items.map(field)}</FieldRow>;
      case 'section':
        return (
          <Section key={i} title={n.title} className="addon-section">
            {nodes(n.body)}
          </Section>
        );
      case 'tabs': {
        const active = activeTab(n);
        const shown = n.items.find((t) => t.id === active)!.body;
        if (n === windowTabs) return <div key={`${n.id}:${active}`}>{nodes(shown)}</div>;
        const filled = filling && fills(n);
        // The note goes where Looper's Git tab puts its branch: at the strip's end, under the tabs where narrow, over the list on a phone.
        const note = n.note && <span className="muted tabs-note">{n.note}</span>;
        return (
          <div key={i} className={`addon-tabs${filled ? ' filled' : ''}`}>
            {/* A phone's pushed detail covers the tabs too, as the Git tab's does. */}
            {!pushed && (
              <div className="tabs-head">
                <TabBar tabs={n.items.map((t) => [t.id, t.title] as const)} active={active} onSelect={selectTab(n)} />
                {!narrow && !isPhone && note}
              </div>
            )}
            {isPhone && n.note && !pushed && <div className="pg-list-note">{n.note}</div>}
            <div key={`${n.id}:${active}`} className="addon-tab-body">
              {filled ? parts(shown) : nodes(shown)}
            </div>
            {narrow && !isPhone && note && !pushed && <div className="tabs-foot">{note}</div>}
          </div>
        );
      }
      case 'listDetail':
        return (
          <AddonListDetail
            key={`list-${n.id}`}
            node={n}
            picked={listSel[n.id]}
            onPick={(id) => setListSel((m) => ({ ...m, [n.id]: id }))}
            stack={narrow || !!n.stack}
            busy={busy}
            onMenuPick={(b, row: AddonListRow) => void send('click', b.id, b.confirm, undefined, row.id)}
            onMore={() => void window.looper.addons.event(addonId, { source: { ...source.current }, kind: 'more', id: n.id }).catch(reportError)}
            onPushed={setPushed}
            head={n.head && nodes(n.head.body)}
            detail={(row) => (
              <AddonScreenView
                key={`${row.detail!.view}/${JSON.stringify(row.detail!.params ?? {})}`}
                addonId={addonId}
                addonName={addonName}
                view={row.detail!.view}
                params={row.detail!.params ?? {}}
                mode="fill"
                narrow
              />
            )}
          />
        );
      case 'diff':
        return <DiffPane key={i} title={n.title} subtitle={n.subtitle} file={n.file} diff={{ binary: !!n.binary, hunks: n.hunks, truncated: !!n.truncated }} />;
      case 'footer':
        // In the main window a footer is an ordinary button row.
        if (mode === 'window') return null;
        if ('wizard' in n) {
          const w = n.wizard;
          return buttonRow(i, [
            { id: w.back ?? 'back', label: 'Back', disabled: !w.back },
            w.commit ? { ...w.commit, disabled: missing || w.commit.disabled } : { id: w.next!, label: 'Next', primary: true, disabled: missing },
          ]);
        }
        // A required field without a value holds the commit back, as a window's footer does.
        return buttonRow(i, [{ ...n.primary, disabled: missing || n.primary.disabled }, ...(n.apply ? [n.apply] : [])]);
    }
  };

  /** A screen's nodes, each run of fields one group. */
  const nodes = (list: AddonNode[]) =>
    fieldRuns(list).map((run) =>
      run.fields ? <FormGroup key={`fields-${run.at}`}>{run.nodes.map((n, j) => node(n, run.at + j))}</FormGroup> : node(run.nodes[0], run.at),
    );

  /**
   * A screen with a part that fills its place (a list beside its detail, a diff), in the main window or
   * filling a tab: that part takes the room left, and the parts between are padded, and make way for a
   * phone's pushed detail.
   */
  const parts = (list: AddonNode[]) => {
    const out: ReactNode[] = [];
    let part: ReactNode[] = [];
    const flush = (at: number) => {
      if (part.length && !pushed) {
        out.push(
          <div key={`part-${at}`} className="addon-fill-part">
            {part}
          </div>,
        );
      }
      part = [];
    };
    for (const run of fieldRuns(list)) {
      if (!run.fields && fills(run.nodes[0])) {
        flush(run.at);
        out.push(node(run.nodes[0], run.at));
      } else part.push(run.fields ? <FormGroup key={`fields-${run.at}`}>{run.nodes.map((n, j) => node(n, run.at + j))}</FormGroup> : node(run.nodes[0], run.at));
    }
    flush(list.length);
    return out;
  };

  const failed = error !== null && <ScreenFailed addonId={addonId} addonName={addonName} error={error} retry={load} />;

  const instruction = screen?.instruction && !pushed && <MainInstruction>{screen.instruction}</MainInstruction>;
  const page = failed || (screen && (
    <SharedLabels>
      {filling && instruction ? <div className="addon-fill-part">{instruction}</div> : instruction}
      {filling ? parts(screen.body) : nodes(screen.body)}
    </SharedLabels>
  ));

  if (mode === 'inline') return <div className="addon-screen addon-inline">{page}</div>;
  if (mode === 'fill') return <div className={`addon-screen addon-fill${filling ? '' : ' status-pane'}`}>{page}</div>;
  if (mode === 'main') {
    return (
      <DetailView title={screen?.title ?? ''} className="detail addon-screen">
        <div className={filling ? 'addon-fill' : 'status-pane'}>{page}</div>
      </DetailView>
    );
  }
  const wizard = footer?.type === 'footer' && 'wizard' in footer ? footer.wizard : null;
  const click = (b: { id: string; confirm?: string }) => () => void send('click', b.id, b.confirm);
  return (
    <div className="editor addon-screen">
      {toolbar}
      {windowTabs && (
        <TabBar
          tabs={windowTabs.items.map((t) => [t.id, t.title] as const)}
          active={activeTab(windowTabs)}
          onSelect={selectTab(windowTabs)}
          className="editor-tabs"
        />
      )}
      <div className="editor-body">
        {/* A list fills the window, as in Looper's own list windows (the Recycle Bin). */}
        <div className={filling ? 'addon-fill' : `form${screen?.body.some(isList) ? ' env-tab' : ''}`} ref={pageRef}>
          {page}
        </div>
      </div>
      {wizard ? (
        <WindowActions
          draft={screen ? values : null}
          wizard={{
            back: { disabled: !wizard.back, run: click({ id: wizard.back ?? '' }) },
            next: wizard.commit
              ? { disabled: missing || wizard.commit.disabled, run: click(wizard.commit) }
              : { disabled: missing, run: click({ id: wizard.next! }) },
            commit: wizard.commit?.label,
          }}
          busy={busy}
        />
      ) : footer?.type === 'footer' && 'primary' in footer ? (
        <WindowActions
          draft={screen ? values : null}
          confirm={{ label: footer.primary.label, disabled: missing || footer.primary.disabled, run: click(footer.primary) }}
          apply={footer.apply && { label: footer.apply.label, disabled: footer.apply.disabled, run: click(footer.apply) }}
          busy={busy}
        />
      ) : (
        <WindowActions close />
      )}
    </div>
  );
}

/**
 * An addon window: one of the addon's screens, opened by its openWindow action
 * or a command's `opens`. Its menu bar and toolbar (a phone's bar and More)
 * are the addon's commands placed on its screens; with none, it has neither.
 */
export function AddonWindowApp({ addonId, view, params, title }: { addonId: string; view: string; params: Record<string, unknown>; title: string }) {
  const commandState = useCommandState();
  const [screen, setScreen] = useState<AddonScreenReport | null>(null);
  const name = commandState.addons.find((a) => a.id === addonId)?.name ?? addonId;
  useEffect(() => {
    document.title = title;
  }, [title]);
  const commands: CommandContext = { ...commandState, addon: { id: addonId, ...(screen ? { screen } : {}) } };
  useCommandMenu(ADDON_WINDOW_VIEWS, commands);
  return <AddonScreenView addonId={addonId} addonName={name} view={view} params={params} mode="window" onScreen={setScreen} toolbar={<CommandBar views={ADDON_WINDOW_VIEWS} context={commands} />} />;
}
