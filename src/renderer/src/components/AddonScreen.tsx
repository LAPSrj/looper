import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AddonButton, AddonEventKind, AddonField, AddonNode, AddonProp, AddonScreen } from '@shared/addons';
import { ADDON_WINDOW_VIEWS } from '@shared/commands/build';
import type { AddonContext, CommandContext } from '@shared/commands/context';
import { DetailView } from './DetailView';
import { CommandBar } from './Toolbar';
import { useCommandMenu, useCommandState } from './useCommands';
import { PathField } from './form-blocks';
import { useDialogKeys } from './hooks';
import { Markdown } from './Markdown';
import { PropertyList, type Property } from './PropertyList';
import { CheckboxField, Field, FieldRow, FormGroup, InfoBar, InputSuffix, NumberInput, SelectInput, TabBar, TextArea, TextInput } from './ui';
import { WindowActions } from './WindowActions';

type Value = string | number | boolean;
type Values = Record<string, Value>;

/** Every field of a screen, inside rows and sections too. */
function fieldsOf(nodes: AddonNode[]): AddonField[] {
  return nodes.flatMap((n) =>
    n.type === 'field'
      ? [n]
      : n.type === 'row'
        ? n.items
        : n.type === 'section'
          ? fieldsOf(n.body)
          : n.type === 'tabs'
            ? n.items.flatMap((t) => fieldsOf(t.body))
            : [],
  );
}

/** A screen's nodes in order: each run of fields and rows together (a FormGroup), every other node alone. */
function fieldRuns(nodes: AddonNode[]): { at: number; fields: boolean; nodes: AddonNode[] }[] {
  const runs: { at: number; fields: boolean; nodes: AddonNode[] }[] = [];
  nodes.forEach((n, at) => {
    const fields = n.type === 'field' || n.type === 'row';
    const last = runs[runs.length - 1];
    if (fields && last?.fields) last.nodes.push(n);
    else runs.push({ at, fields, nodes: [n] });
  });
  return runs;
}

const emptyValue = (f: AddonField): Value => (f.input === 'checkbox' ? false : f.input === 'number' ? 0 : '');

/** Fields keep what the user typed across redraws; only fields new to the screen take the addon's value. */
function mergeValues(prev: Values, fields: AddonField[]): Values {
  const next: Values = {};
  for (const f of fields) next[f.id] = f.id in prev ? prev[f.id] : (f.value ?? emptyValue(f));
  return next;
}

const SECRET_MASK = '••••••••';
/** A new screen slower than this to draw goes to the engine log. */
const SLOW_DRAW_MS = 500;

/** What a screen tells its window, for the commands placed on it (CommandContext `addon.screen`). */
export type AddonScreenReport = NonNullable<AddonContext['screen']>;

/**
 * An addon's screen, drawn from the nodes it sent: in the main window's
 * detail area (`main`), as the whole of an addon window (`window`, with its
 * footer as the window's Save | Cancel | Apply), or as its body alone inside
 * another view (`inline`: a tool call's result on the Now tab). It draws no
 * toolbar or menus of its own: it reports its state (`onScreen`), and its
 * window builds them from the addon's commands, as it does Looper's.
 */
export function AddonScreenView({
  addonId,
  addonName,
  view,
  params,
  mode,
  onScreen,
  toolbar,
}: {
  addonId: string;
  addonName: string;
  view: string;
  params: Record<string, unknown>;
  mode: 'main' | 'window' | 'inline';
  /** The screen showing and its commands' state, or null once it's gone. */
  onScreen?: (screen: AddonScreenReport | null) => void;
  /** `window`: the window's toolbar, at its top. */
  toolbar?: ReactNode;
}) {
  const [screen, setScreen] = useState<AddonScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
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
      })
      .catch((e: Error) => {
        if (n === latestLoad.current) setError(e.message);
      });
  }, [addonId, view, paramsKey]);

  // When a new screen was asked for, until it's drawn: a slow one is logged.
  const asked = useRef<{ at: number; addonId: string; view: string } | null>(null);
  // The selected tab of each tabs node, by its id: kept across redraws of the same screen.
  const [tabSel, setTabSel] = useState<Record<string, string>>({});
  useEffect(() => {
    setScreen(null);
    setError(null);
    setValues({});
    setRevealed({});
    setTabSel({});
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
        if (e.type === 'refresh' && e.addonId === addonId) {
          setRevealed({});
          load();
        } else if (e.type === 'addons' && e.addons.some((a) => a.id === addonId && a.status === 'running')) load();
      }),
    [addonId, load],
  );

  useEffect(() => {
    if (!screen?.refreshSec) return;
    const t = setTimeout(load, screen.refreshSec * 1000);
    return () => clearTimeout(t);
  }, [screen, load]);

  const send = async (kind: AddonEventKind, id: string, confirm?: string) => {
    const { view: v, params: p } = source.current;
    setBusy(true);
    try {
      const r = await window.looper.addons.event(addonId, { source: { view: v, params: p }, kind, id, values }, confirm);
      if (r.values) setValues((prev) => ({ ...prev, ...r.values }));
      if (kind === 'reveal' && r.value !== undefined) setRevealed((m) => ({ ...m, [id]: r.value! }));
    } finally {
      setBusy(false);
    }
  };

  // The commands placed on the screen reach it through its window, with the fields' values as they are then.
  const sendRef = useRef(send);
  sendRef.current = send;
  const reportRef = useRef(onScreen);
  reportRef.current = onScreen;
  const commandState = screen?.commands;
  const stateKey = JSON.stringify(commandState ?? null);
  const shown = !!screen;
  useEffect(() => {
    if (shown) reportRef.current?.({ view, state: commandState, run: (id, confirm) => void sendRef.current('command', id, confirm) });
  }, [view, stateKey, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => reportRef.current?.(null), []);

  const fields = screen ? fieldsOf(screen.body) : [];
  const missing = fields.some((f) => f.required && (values[f.id] === undefined || String(values[f.id]).trim() === ''));
  const footer = mode === 'window' ? screen?.body.find((n) => n.type === 'footer') : undefined;

  type TabsNode = Extract<AddonNode, { type: 'tabs' }>;
  const activeTab = (n: TabsNode) => (n.items.some((t) => t.id === tabSel[n.id]) ? tabSel[n.id] : n.items[0].id);
  const selectTab = (n: TabsNode) => (id: string) => setTabSel((m) => ({ ...m, [n.id]: id }));
  // A window's top-level tabs go across the top of the window, as in Looper's own editors.
  const windowTabs = mode === 'window' ? (screen?.body.find((n) => n.type === 'tabs') as TabsNode | undefined) : undefined;

  useDialogKeys({
    tabs: windowTabs?.items.map((t) => t.id),
    tab: windowTabs ? activeTab(windowTabs) : undefined,
    onTab: windowTabs ? selectTab(windowTabs) : undefined,
  });

  const button = (b: AddonButton) => (
    <button
      key={b.id}
      className={`btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`}
      disabled={b.disabled || busy}
      onClick={() => void send('click', b.id, b.confirm)}
    >
      {b.label}
    </button>
  );

  const setValue = (id: string, v: Value) => setValues((m) => ({ ...m, [id]: v }));

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
          <Field key={f.id} label={f.label}>
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
          <Field key={f.id} label={f.label}>
            <SelectInput value={String(v)} autoFocus={f.autofocus} onChange={(e) => setValue(f.id, e.target.value)}>
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        );
      case 'number':
        return (
          <Field key={f.id} label={f.label}>
            <NumberInput suffix={f.suffix} value={Number(v) || 0} autoFocus={f.autofocus} onChange={(n) => setValue(f.id, n)} />
          </Field>
        );
      default:
        return (
          <Field key={f.id} label={f.label}>
            {f.suffix ? <InputSuffix suffix={f.suffix}>{text(f.input)}</InputSuffix> : text(f.input)}
          </Field>
        );
    }
  };

  const prop = (p: AddonProp): Property => {
    const secret = p.secret;
    const shown = secret ? revealed[secret] : undefined;
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
            action={n.button ? button(n.button) : undefined}
          />
        );
      case 'buttons':
        return (
          <div key={i} className="env-actions">
            {n.items.map(button)}
          </div>
        );
      case 'field':
        return field(n);
      case 'row':
        return <FieldRow key={i}>{n.items.map(field)}</FieldRow>;
      case 'section':
        return (
          <section key={i}>
            <h3>{n.title}</h3>
            {nodes(n.body)}
          </section>
        );
      case 'tabs': {
        const active = activeTab(n);
        const body = <div key={`${n.id}:${active}`}>{nodes(n.items.find((t) => t.id === active)!.body)}</div>;
        if (n === windowTabs) return body;
        return (
          <div key={i} className="addon-tabs">
            <TabBar tabs={n.items.map((t) => [t.id, t.title] as const)} active={active} onSelect={selectTab(n)} />
            {body}
          </div>
        );
      }
      case 'footer':
        // In the main window a footer is an ordinary button row.
        return mode === 'window' ? null : (
          <div key={i} className="env-actions">
            {[n.primary, ...(n.apply ? [n.apply] : [])].map(button)}
          </div>
        );
    }
  };

  /** A screen's nodes, each run of fields one group. */
  const nodes = (list: AddonNode[]) =>
    fieldRuns(list).map((run) =>
      run.fields ? <FormGroup key={`fields-${run.at}`}>{run.nodes.map((n, j) => node(n, run.at + j))}</FormGroup> : node(run.nodes[0], run.at),
    );

  const failed = error !== null && (
    <InfoBar stacked title={`${addonName} couldn't show this screen`} message={error} action={<button className="btn" onClick={load}>Try Again</button>} />
  );

  if (mode === 'inline') return <div className="addon-screen addon-inline">{failed || (screen && nodes(screen.body))}</div>;
  if (mode === 'main') {
    return (
      <DetailView title={screen?.title ?? ''} className="detail addon-screen">
        <div className="status-pane">{failed || (screen && nodes(screen.body))}</div>
      </DetailView>
    );
  }
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
        <div className="form">{failed || (screen && nodes(screen.body))}</div>
      </div>
      {footer?.type === 'footer' ? (
        <WindowActions
          confirm={{ label: footer.primary.label, disabled: missing || footer.primary.disabled, run: () => void send('click', footer.primary.id, footer.primary.confirm) }}
          apply={footer.apply && { label: footer.apply.label, disabled: footer.apply.disabled, run: () => void send('click', footer.apply!.id, footer.apply!.confirm) }}
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
