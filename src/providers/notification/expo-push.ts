import { NotificationProviderError, type PushMessage, type PushProvider, type SendResult } from './types';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100; // Expo's per-request limit
export const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);

interface Ticket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Expo Push API (works for the Expo app on Android and iOS without separate FCM/APNs code here).
 * Only Expo tokens are sent; `DeviceNotRegistered` tokens are reported back so the device registration is deactivated.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo-push';
  constructor(private readonly o: { accessToken?: string; timeoutMs?: number } = {}) {}

  async send(m: PushMessage): Promise<SendResult> {
    const tokens = m.tokens.map((t) => t.token).filter(isExpoPushToken);
    if (!tokens.length) return {};
    const invalid: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < tokens.length; i += BATCH) {
      const chunk = tokens.slice(i, i + BATCH);
      const payload = chunk.map((to) => ({
        to,
        title: m.title,
        body: m.body,
        data: { ...m.data, reference: m.reference },
        sound: 'default',
        priority: 'high',
      }));
      let res: Response;
      try {
        res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(this.o.accessToken ? { authorization: `Bearer ${this.o.accessToken}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
        });
      } catch (err) {
        throw new NotificationProviderError(`Expo push unreachable: ${(err as Error).name}`, true);
      }
      if (!res.ok)
        throw new NotificationProviderError(`Expo push rejected (${res.status})`, res.status === 429 || res.status >= 500);
      const tickets = ((await res.json()) as { data?: Ticket[] }).data ?? [];
      tickets.forEach((t, idx) => {
        if (t.status === 'ok' && t.id) ids.push(t.id);
        else if (t.details?.error === 'DeviceNotRegistered') invalid.push(chunk[idx]!);
      });
    }
    return { providerMessageId: ids[0], invalidTokens: invalid.length ? invalid : undefined };
  }
}
