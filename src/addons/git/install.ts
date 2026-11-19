/**
 * Installing git where it's missing. In WSL (or Linux) the script finds the
 * package manager and runs it with sudo -A, so sudo asks for the password
 * through the askpass script (askpass.ts); as root it runs it directly, and
 * without sudo it says what to run as root instead. On Windows, winget.
 */

/** A WSL environment's install, run with sh -c. Exits 3 with no package manager it knows, and 4 without sudo, saying so on stdout. */
export const INSTALL_SCRIPT = [
  'pm=',
  'for p in apt-get dnf zypper pacman apk; do if command -v "$p" >/dev/null 2>&1; then pm=$p; break; fi; done',
  'case "$pm" in',
  `  apt-get) c='apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git' ;;`,
  `  dnf) c='dnf install -y git' ;;`,
  `  zypper) c='zypper --non-interactive install git' ;;`,
  `  pacman) c='pacman -S --noconfirm --needed git' ;;`,
  `  apk) c='apk add git' ;;`,
  `  *) printf 'looper-install: no-manager\n'; exit 3 ;;`,
  'esac',
  'if [ "$(id -u)" = 0 ]; then exec sh -c "$c"; fi',
  'if ! command -v sudo >/dev/null 2>&1; then printf \'looper-install: no-sudo\\n%s\\n%s\\n\' "$c" "${WSL_DISTRO_NAME:-}"; exit 4; fi',
  'exec sudo -A sh -c "$c"',
].join('\n');

/** A Windows environment's install. */
export const WINGET = ['winget', 'install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'];

/** What INSTALL_SCRIPT's output says went wrong before it could install: no package manager, or no sudo (with the command to run as root, and the distro's name when it runs in WSL). */
export function installProblem(stdout: string): { kind: 'no-manager' } | { kind: 'no-sudo'; command: string; distro?: string } | undefined {
  if (/^looper-install: no-manager$/m.test(stdout)) return { kind: 'no-manager' };
  const m = /^looper-install: no-sudo\n(.*)\n(.*)$/m.exec(stdout);
  if (!m) return undefined;
  return { kind: 'no-sudo', command: m[1], ...(m[2].trim() ? { distro: m[2].trim() } : {}) };
}

/** How to install git as root, from a Windows terminal when the distro is known. */
export function rootCommand(p: { command: string; distro?: string }): string {
  return p.distro ? `wsl.exe -d ${p.distro} -u root sh -c "${p.command}"` : `su -c "${p.command}"`;
}

/** The last lines of a long output (a package manager's), for a message's details. */
export function tail(text: string, count = 20): string {
  const all = text.trim().split(/\r?\n/);
  return all.slice(-count).join('\n');
}
