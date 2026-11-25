export function isRfc1918LanIp(ip = '') {
  const addr = String(ip || '').trim();
  if (addr.startsWith('192.168.') || addr.startsWith('10.')) return true;
  const m = /^172\.(\d+)\./.exec(addr);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export function isCgnatOrLinkLocalIp(ip = '') {
  const addr = String(ip || '').trim();
  if (addr.startsWith('169.254.')) return true;
  const m = /^100\.(\d+)\./.exec(addr);
  if (m) {
    const second = Number(m[1]);
    return second >= 64 && second <= 127; // Tailscale / CGNAT range
  }
  return false;
}

export function scoreLanInterface(interfaceName = '', address = '') {
  const name = String(interfaceName || '').toLowerCase();
  const isVirtualOrVpn =
    /tailscale|wireguard|zerotier|vethernet|wsl|hyper-v|docker|virtualbox|vbox|vmware|hamachi|nord|mullvad|openvpn|vpn|utun|tun\d|tap\d|bridge|loopback/.test(
      name
    );
  const isPhysicalLanName =
    /wi-?fi|wlan|ethernet|local area connection|en0|en1|eth0/.test(name) && !isVirtualOrVpn;
  let score = 0;
  if (isRfc1918LanIp(address)) score += 50;
  if (isPhysicalLanName) score += 60;
  if (isVirtualOrVpn) score -= 80;
  if (isCgnatOrLinkLocalIp(address)) score -= 70;
  return score;
}

/**
 * Returns a new array of `{ interfaceName, address }` entries sorted so that
 * real local physical LAN IPv4 addresses (Wi-Fi / Ethernet, RFC1918) always
 * rank ahead of Tailscale / VPN / WSL / virtual / link-local interfaces.
 */
export function rankLanAddresses(lanAddresses = []) {
  if (!Array.isArray(lanAddresses) || lanAddresses.length === 0) return [];
  return [...lanAddresses]
    .filter((entry) => entry && typeof entry.address === 'string' && entry.address.trim())
    .sort(
      (a, b) =>
        scoreLanInterface(b.interfaceName, b.address) -
        scoreLanInterface(a.interfaceName, a.address)
    );
}

export function isLoopbackHost(hostname = '') {
  const h = String(hostname || '').toLowerCase().trim();
  return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function isIpv4Address(hostname = '') {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(hostname || '').trim());
}

/**
 * Returns true only for real deployed public domains (e.g. `pingpong.example.com`),
 * and false for localhost, raw IPs, single-label LAN hostnames, `.local`/`.lan`,
 * and Tailscale MagicDNS (`.ts.net`).
 */
export function isDeployedPublicHost(hostname = '') {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h || isLoopbackHost(h) || isIpv4Address(h)) return false;
  if (h.startsWith('[') || h.includes(':')) return false;
  if (!h.includes('.')) return false; // Single-label LAN hostname like "hp-elitebook"
  if (
    h.endsWith('.local') ||
    h.endsWith('.lan') ||
    h.endsWith('.home') ||
    h.endsWith('.internal') ||
    h.endsWith('.localdomain') ||
    h.endsWith('.ts.net')
  ) {
    return false;
  }
  return true;
}

/**
 * Resolves the best shareable origin:
 * - If a custom server URL is explicitly configured, uses it.
 * - If deployed online on a real public domain (e.g. `pingpong.example.com`), uses that URL.
 * - If running locally (localhost, LAN IP, `.local`, `.ts.net`, etc.), ranks all known
 *   interfaces client-side too so the real local Wi-Fi / Ethernet LAN IPv4 always beats
 *   Tailscale / VPN / virtual adapters even if server metadata arrived unsorted.
 */
export function resolveShareOrigin(serverInfo, customServerUrl = '', locationOverride = null) {
  if (customServerUrl && String(customServerUrl).trim()) {
    return String(customServerUrl).trim().replace(/\/+$/, '');
  }
  const loc = locationOverride || (typeof window !== 'undefined' ? window.location : null);
  if (!loc) return '';

  const hostname = loc.hostname || '';
  const proto = loc.protocol || 'http:';
  const port = loc.port || (serverInfo?.port ? String(serverInfo.port) : '');

  if (isDeployedPublicHost(hostname)) {
    return loc.origin || `${proto}//${hostname}${port ? `:${port}` : ''}`;
  }

  const buildInfo =
    typeof __BUILD_SERVER_INFO__ !== 'undefined' ? __BUILD_SERVER_INFO__ : null;
  const candidateAddresses =
    serverInfo?.lanAddresses?.length > 0
      ? serverInfo.lanAddresses
      : buildInfo?.lanAddresses || [];
  const primaryLanIp = rankLanAddresses(candidateAddresses)[0]?.address;
  if (primaryLanIp) {
    return `${proto}//${primaryLanIp}${port ? `:${port}` : ''}`;
  }

  return loc.origin || `${proto}//${hostname}${port ? `:${port}` : ''}`;
}
