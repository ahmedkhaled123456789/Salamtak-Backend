import { randomUUID } from 'node:crypto';
import {
  NotificationProviderError,
  type EmailMessage,
  type EmailProvider,
  type PushMessage,
  type PushProvider,
  type SendResult,
} from './types';

/** Test provider with scripted failures. Never talks to the network. */
class ScriptedProvider<M extends { reference: string }> {
  readonly sent: M[] = [];
  calls = 0;
  failuresRemaining = 0;
  failRetryable = true;
  /** Simulates "provider accepted the message but we crashed before recording it". */
  crashAfterSend = 0;

  protected async deliver(message: M): Promise<SendResult> {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new NotificationProviderError('mock provider failure', this.failRetryable);
    }
    this.sent.push(message);
    const result = { providerMessageId: `mock_${randomUUID()}` };
    if (this.crashAfterSend > 0) {
      this.crashAfterSend -= 1;
      throw new Error('simulated crash after provider accepted the message');
    }
    return result;
  }
}

export class MockEmailProvider extends ScriptedProvider<EmailMessage> implements EmailProvider {
  readonly name = 'mock-email';
  send(message: EmailMessage): Promise<SendResult> {
    return this.deliver(message);
  }
}
export class MockPushProvider extends ScriptedProvider<PushMessage> implements PushProvider {
  readonly name = 'mock-push';
  send(message: PushMessage): Promise<SendResult> {
    return this.deliver(message);
  }
}
