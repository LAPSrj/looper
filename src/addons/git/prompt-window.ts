import type { AddonNode, AddonScreen, AddonValue } from '../../shared/addons';
import type { AskContext, Asked, Prompt } from './askpass';

/** A prompt's window: its title, its size (nothing in it scrolls) and its screen. */
export interface PromptWindow {
  title: string;
  width: number;
  height: number;
  screen: AddonScreen;
}

/** The height the error under the field takes, when a prompt is asked again. */
const RETRY_HEIGHT = 28;

const field = (id: string, label: string, secret: boolean, required = true): AddonNode => ({
  type: 'field',
  id,
  label,
  input: secret ? 'password' : 'text',
  value: '',
  ...(required ? { required: true } : {}),
  ...(id === 'answer' || id === 'username' ? { autofocus: true } : {}),
});

const footer = (label: string): AddonNode => ({ type: 'footer', primary: { id: 'answer', label, primary: true } });

/** The prompt's text without the question's punctuation at its end: its last line is the question. */
function lines(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * What a prompt from git, ssh or sudo looks like as a window: a sign-in asks
 * for the user name and the password together (git asks for the password
 * next, and gets this one), a passphrase or a password alone has its field,
 * and an unknown host shows its key's fingerprint, with Connect.
 */
export function promptWindow(p: Prompt, retry: boolean, purpose?: AskContext['purpose']): PromptWindow {
  const w = ((): PromptWindow => {
    switch (p.kind) {
      case 'username':
        return {
          title: 'Sign In',
          width: 480,
          height: 300,
          screen: { instruction: `Sign in to ${p.host}`, body: [field('username', 'User name', false), field('password', 'Password', true, false), footer('Sign In')] },
        };
      case 'password':
        return {
          title: 'Sign In',
          width: 480,
          height: 230,
          screen: {
            instruction: p.user ? `Sign in to ${p.host} as ${p.user}` : `Sign in to ${p.host}`,
            body: [field('answer', 'Password', true), footer('Sign In')],
          },
        };
      case 'passphrase':
        return {
          title: 'SSH Key',
          width: 520,
          height: 230,
          screen: {
            instruction: p.key ? `Enter the passphrase for ${p.key}` : 'Enter the passphrase for the SSH key',
            body: [field('answer', 'Passphrase', true), footer('Unlock')],
          },
        };
      case 'pin':
        return {
          title: 'Security Key',
          width: 480,
          height: 230,
          screen: { instruction: p.key ? `Enter the PIN for ${p.key}` : 'Enter the PIN for the security key', body: [field('answer', 'PIN', true), footer('Unlock')] },
        };
      case 'sudo':
        return purpose === 'install'
          ? {
              title: 'Install Git',
              width: 480,
              height: 230,
              screen: { instruction: `Enter the password for ${p.user} to install Git`, body: [field('answer', 'Password', true), footer('Install')] },
            }
          : {
              title: 'Sudo',
              width: 480,
              height: 230,
              screen: { instruction: `Enter the password for ${p.user}`, body: [field('answer', 'Password', true), footer('OK')] },
            };
      case 'hostKey': {
        const name = p.host.replace(/\s*\(.*$/, '');
        return {
          title: 'Unknown Host',
          width: 560,
          height: 320,
          screen: {
            instruction: `Connect to ${name}?`,
            body: [
              { type: 'text', text: "Git hasn't connected to this host before. Connect only if the fingerprint is the one the host publishes." },
              {
                type: 'props',
                items: [
                  { label: 'Host', value: p.host },
                  ...(p.fingerprint ? [{ label: p.keyType ? `${p.keyType} fingerprint` : 'Fingerprint', value: p.fingerprint, mono: true, copy: true }] : []),
                ],
              },
              footer('Connect'),
            ],
          },
        };
      }
      case 'confirm': {
        const all = lines(p.text);
        const question = all.pop()!.replace(/\s*\(yes\/no[^)]*\)\?$/i, '?');
        return {
          title: 'Git',
          width: 560,
          height: 220 + Math.min(all.length, 6) * 20,
          screen: { instruction: question, body: [...(all.length ? [{ type: 'text' as const, text: all.join('\n') }] : []), footer('Continue')] },
        };
      }
      case 'other': {
        const all = lines(p.text);
        const question = (all.pop() ?? 'Git needs an answer').replace(/:$/, '');
        return {
          title: 'Git',
          width: 520,
          height: 240 + Math.min(all.length, 6) * 20,
          screen: { instruction: question, body: [...(all.length ? [{ type: 'text' as const, text: all.join('\n') }] : []), field('answer', 'Answer', p.secret), footer('OK')] },
        };
      }
    }
  })();
  if (!retry) return w;
  const noun = p.kind === 'passphrase' ? 'passphrase' : p.kind === 'pin' ? 'PIN' : 'password';
  // The answer it gave was refused: the problem is under the field it's typed in again (Windows' in-place error).
  return {
    ...w,
    height: w.height + RETRY_HEIGHT,
    screen: { ...w.screen, body: w.screen.body.map((n) => (n.type === 'field' && n.input === 'password' ? { ...n, error: `The ${noun} is incorrect` } : n)) },
  };
}

/** The answer a prompt's window gave, from its fields' values. */
export function promptAnswer(p: Prompt, values: Record<string, AddonValue>): Exclude<Asked, 'failed' | 'cancelled'> {
  const text = (id: string) => (typeof values[id] === 'string' ? (values[id] as string) : '');
  if (p.kind === 'hostKey' || p.kind === 'confirm') return { answer: 'yes' };
  if (p.kind === 'username') return { answer: text('username'), ...(text('password') ? { password: text('password') } : {}) };
  return { answer: text('answer') };
}
