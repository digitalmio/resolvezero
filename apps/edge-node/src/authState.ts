import type { IpUpdateEvent } from "@resolvezero/shared";

/** Profile credentials, DoT labels, and linked source IPs. */
export class AuthState {
  profileTokens = new Map<string, string | null>();
  dotIds = new Map<string, string>();
  authorizedSourceIps = new Map<string, string>();

  replace(
    profileTokens: Map<string, string | null>,
    dotIds: Map<string, string>,
    sourceIps: Map<string, string>,
  ): void {
    this.profileTokens = profileTokens;
    this.dotIds = dotIds;
    this.authorizedSourceIps = sourceIps;
  }

  hasProfile(profileId: string, token: string | undefined): boolean {
    if (!/^[a-z0-9-]{1,64}$/i.test(profileId)) return false;
    const stored = this.profileTokens.get(profileId);
    if (stored === undefined) return false;
    if (stored === null) return true;
    if (!token) return false;
    return constantTimeEquals(token, stored);
  }

  authorizeDotId(dotId: string): string | undefined {
    return this.dotIds.get(dotId);
  }

  authorizeSourceIp(ip: string): string | undefined {
    return this.authorizedSourceIps.get(ip);
  }

  applySourceIpEvent(event: IpUpdateEvent): void {
    if (event.op === "DELETE") {
      this.authorizedSourceIps.delete(event.ip_address);
      return;
    }
    this.authorizedSourceIps.set(event.ip_address, event.profile_id);
  }

  hasToken(profileId: string): boolean {
    const stored = this.profileTokens.get(profileId);
    return stored !== undefined && stored !== null;
  }

  tokenlessProfileIds(): string[] {
    return [...this.profileTokens.entries()]
      .filter(([, token]) => token === null)
      .map(([id]) => id);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
