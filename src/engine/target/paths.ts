import type { HostKind } from '../host';

export interface PathTranslateOpts {
  host: HostKind;
  targetKind: 'wsl' | 'windows';
  wslMountPrefix: string; // "/mnt"
  /** Distro name of the WSL host itself (for \\wsl.localhost\<distro>\... paths). */
  hostDistro?: string;
}

/** Translate a path that exists on the host into the form the target sees it. */
export function translatePath(hostPath: string, o: PathTranslateOpts): string {
  const prefix = o.wslMountPrefix.replace(/\/+$/, '');
  if (o.host === 'windows' && o.targetKind === 'wsl') {
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
    if (drive) {
      return `${prefix}/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
    }
    const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+\\(.*)$/.exec(hostPath);
    if (unc) return '/' + unc[1].replace(/\\/g, '/');
    throw new Error(`cannot translate host path to WSL: ${hostPath}`);
  }
  if (o.host === 'wsl' && o.targetKind === 'windows') {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^${escaped}/([a-zA-Z])/(.*)$`).exec(hostPath);
    if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    if (!o.hostDistro) throw new Error(`cannot translate ${hostPath}: unknown WSL distro name`);
    return `\\\\wsl.localhost\\${o.hostDistro}${hostPath.replace(/\//g, '\\')}`;
  }
  if ((o.host === 'linux' || o.host === 'mac') && o.targetKind === 'windows') {
    throw new Error('windows target is only reachable from a Windows or WSL host');
  }
  return hostPath;
}

/**
 * Translate a target-native path into a form the host process can read
 * (the inverse of translatePath): a WSL path becomes a \\wsl.localhost UNC
 * path on a Windows host, a Windows path becomes a mount path on a WSL host.
 */
export function translateToHost(
  targetPath: string,
  o: Omit<PathTranslateOpts, 'hostDistro'> & { targetDistro?: string },
): string {
  if (o.host === 'windows' && o.targetKind === 'wsl') {
    return translatePath(targetPath, {
      host: 'wsl',
      targetKind: 'windows',
      wslMountPrefix: o.wslMountPrefix,
      hostDistro: o.targetDistro,
    });
  }
  if (o.host === 'wsl' && o.targetKind === 'windows') {
    return translatePath(targetPath, { host: 'windows', targetKind: 'wsl', wslMountPrefix: o.wslMountPrefix });
  }
  return targetPath;
}

export function joinTarget(kind: 'wsl' | 'windows', base: string, ...parts: string[]): string {
  const sep = kind === 'windows' ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}
