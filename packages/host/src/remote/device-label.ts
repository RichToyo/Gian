import { MAX_NAME_CHARS, MAX_STRING_CHARS } from '@gian/remote-protocol';

export const GENERIC_REMOTE_DEVICE_NAME = 'Remote device';

const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}]/u;

export function normalizeRemoteDeviceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_NAME_CHARS || UNSAFE_NAME_CHARS.test(name)) {
    throw new Error('invalid_device_name');
  }
  return name;
}

export function remoteDeviceDisplayName(input: {
  name?: string | null;
  platform?: string | null;
  userAgent?: string | null;
}): string {
  const explicit = safeName(input.name);
  if (explicit && explicit !== GENERIC_REMOTE_DEVICE_NAME) return explicit;
  return describeRemoteDevice(input.platform, input.userAgent);
}

export function describeRemoteDevice(
  platformValue?: string | null,
  userAgentValue?: string | null,
): string {
  const platform = safeHint(platformValue, MAX_NAME_CHARS).toLowerCase();
  const userAgent = safeHint(userAgentValue, MAX_STRING_CHARS).toLowerCase();
  const source = `${platform} ${userAgent}`;
  const device = /iphone|ipod/.test(source) ? 'iPhone'
    : /ipad/.test(source) || (/macintosh/.test(userAgent) && /mobile/.test(userAgent)) ? 'iPad'
      : /android/.test(source) ? 'Android'
        : /windows|win32|win64/.test(source) ? 'Windows'
          : /darwin|macintel|mac os|macintosh/.test(source) || platform === 'macos' ? 'macOS'
            : /^ios$/.test(platform) ? 'iOS'
              : /linux|x11/.test(source) ? 'Linux'
                : GENERIC_REMOTE_DEVICE_NAME;
  const browser = /\bgian(?:dev)?(?: desktop)?[\/ ]/i.test(userAgent) ? 'Gian'
    : /edgios\/|edga\/|edg\//.test(userAgent) ? 'Edge'
      : /crios\/|chrome\//.test(userAgent) ? 'Chrome'
        : /fxios\/|firefox\//.test(userAgent) ? 'Firefox'
          : /safari\//.test(userAgent) ? 'Safari'
            : null;
  if (device === GENERIC_REMOTE_DEVICE_NAME) return browser ? `Browser · ${browser}` : device;
  return browser ? `${device} · ${browser}` : device;
}

function safeName(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_NAME_CHARS && !UNSAFE_NAME_CHARS.test(name) ? name : null;
}

function safeHint(value: string | null | undefined, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || UNSAFE_NAME_CHARS.test(value)) return '';
  return value.trim();
}
