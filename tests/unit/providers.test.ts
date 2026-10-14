import { LogMessenger, ProviderMessenger } from '../../src/providers/messaging/messenger';
import { TwilioSmsProvider } from '../../src/providers/messaging/twilio';
import { ExpoPushProvider } from '../../src/providers/notification/expo-push';
import { SesEmailProvider } from '../../src/providers/notification/ses';
import { NotificationProviderError } from '../../src/providers/notification/types';
import { S3StorageProvider } from '../../src/providers/storage/s3';

const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
const fetchMock = jest.fn();
const json = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response;
const call = (i = 0) => fetchMock.mock.calls[i] as [URL | string, RequestInit];

beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('S3StorageProvider', () => {
  const aws = new S3StorageProvider({ bucket: 'care-files', region: 'me-central-1', credentials: creds, serverSideEncryption: 'AES256' });

  it('PUTs a signed, non-overwriting, encrypted object at the virtual-hosted AWS URL', async () => {
    fetchMock.mockResolvedValueOnce(json(200));
    await expect(aws.put('nurse_document/u1/a.png', Buffer.from('img'), { contentType: 'image/png', sha256: 'abc' })).resolves.toEqual({
      key: 'nurse_document/u1/a.png',
      size: 3,
    });
    const [url, init] = call();
    expect(String(url)).toBe('https://care-files.s3.me-central-1.amazonaws.com/nurse_document/u1/a.png');
    const h = init.headers as Record<string, string>;
    expect(init.method).toBe('PUT');
    expect(h['if-none-match']).toBe('*');
    expect(h['x-amz-server-side-encryption']).toBe('AES256');
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/me-central-1\/s3\/aws4_request/);
    expect(h.host).toBeUndefined();
  });

  it('uses path-style URLs for MinIO-like endpoints', async () => {
    const minio = new S3StorageProvider({ bucket: 'b', region: 'us-east-1', credentials: creds, endpoint: 'http://localhost:9000/', forcePathStyle: true });
    fetchMock.mockResolvedValueOnce(json(404));
    await expect(minio.get('k/1')).resolves.toBeNull();
    expect(String(call()[0])).toBe('http://localhost:9000/b/k/1');
  });

  it('maps HEAD 404 to false, throws on server errors and rejects unsafe keys before any request', async () => {
    fetchMock.mockResolvedValueOnce(json(404)).mockResolvedValueOnce(json(200)).mockResolvedValueOnce(json(500));
    await expect(aws.exists('a')).resolves.toBe(false);
    await expect(aws.exists('a')).resolves.toBe(true);
    await expect(aws.get('a')).rejects.toThrow('S3 GET failed (500)');
    await expect(aws.get('../etc/passwd')).rejects.toThrow('invalid storage key');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('SesEmailProvider', () => {
  const ses = new SesEmailProvider({ region: 'eu-west-1', from: 'CareFlow <no-reply@careflow.ae>', credentials: creds });

  it('sends a signed SendEmail v2 request and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { MessageId: 'm-1' }));
    await expect(ses.send({ to: 'a@b.test', subject: 'S', body: 'B', reference: 'r' })).resolves.toEqual({ providerMessageId: 'm-1' });
    const [url, init] = call();
    expect(String(url)).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    const body = JSON.parse(String(init.body));
    expect(body.Destination.ToAddresses).toEqual(['a@b.test']);
    expect(body.Content.Simple.Subject.Data).toBe('S');
    expect((init.headers as Record<string, string>).Authorization).toContain('/eu-west-1/ses/aws4_request');
  });

  it('retries throttling / server errors but not rejected messages', async () => {
    fetchMock.mockResolvedValueOnce(json(400)).mockResolvedValueOnce(json(429)).mockRejectedValueOnce(new Error('ECONNRESET'));
    const m = { to: 'a@b.test', subject: 'S', body: 'B', reference: 'r' };
    await expect(ses.send(m)).rejects.toMatchObject({ retryable: false });
    await expect(ses.send(m)).rejects.toMatchObject({ retryable: true });
    await expect(ses.send(m)).rejects.toBeInstanceOf(NotificationProviderError);
  });
});

describe('TwilioSmsProvider', () => {
  const tw = new TwilioSmsProvider({ accountSid: 'AC123', authToken: 'tok', messagingServiceSid: 'MG1' });

  it('posts a form with basic auth and the messaging service', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { sid: 'SM1' }));
    await expect(tw.send('+971500000000', 'Your code is 123456')).resolves.toEqual({ providerMessageId: 'SM1' });
    const [url, init] = call();
    expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('To')).toBe('+971500000000');
    expect(form.get('MessagingServiceSid')).toBe('MG1');
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
  });

  it('never retries an invalid number, retries 5xx', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { code: 21211 })).mockResolvedValueOnce(json(503));
    await expect(tw.send('+1', 'x')).rejects.toMatchObject({ retryable: false });
    await expect(tw.send('+971500000000', 'x')).rejects.toMatchObject({ retryable: true });
  });
});

describe('ExpoPushProvider', () => {
  it('sends only Expo tokens in batches of 100 and reports unregistered devices', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => ({ token: `ExponentPushToken[t${i}]`, platform: 'ANDROID' }));
    tokens.push({ token: 'raw-fcm-token-not-expo-format', platform: 'ANDROID' });
    fetchMock
      .mockResolvedValueOnce(json(200, { data: Array.from({ length: 100 }, (_, i) => (i === 3 ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `id${i}` })) }))
      .mockResolvedValueOnce(json(200, { data: Array.from({ length: 50 }, (_, i) => ({ status: 'ok', id: `id${100 + i}` })) }));
    const res = await new ExpoPushProvider().send({ userId: 'u', tokens, title: 'T', body: 'B', reference: 'n1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(call(0)[1].body))).toHaveLength(100);
    expect(JSON.parse(String(call(1)[1].body))).toHaveLength(50);
    expect(res.invalidTokens).toEqual(['ExponentPushToken[t3]']);
  });

  it('does nothing without Expo tokens', async () => {
    await expect(new ExpoPushProvider().send({ userId: 'u', tokens: [{ token: 'x'.repeat(20), platform: 'IOS' }], title: 'T', body: 'B', reference: 'r' })).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ProviderMessenger', () => {
  it('routes EMAIL and SMS to their providers and everything else to the fallback', async () => {
    const email = { name: 'e', send: jest.fn().mockResolvedValue({}) };
    const fallback = new LogMessenger();
    const m = new ProviderMessenger(fallback, email, undefined);
    await m.send({ channel: 'EMAIL', to: 'a@b.test', purpose: 'PASSWORD_RESET', subject: 'Reset', body: 'x' });
    await m.send({ channel: 'SMS', to: '+971500000000', purpose: 'PHONE_OTP', body: 'code' });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.test', subject: 'Reset', reference: expect.stringMatching(/^PASSWORD_RESET:/) }));
    expect(fallback.last('PHONE_OTP')?.to).toBe('+971500000000'); // no SMS provider configured → dev outbox
  });
});
