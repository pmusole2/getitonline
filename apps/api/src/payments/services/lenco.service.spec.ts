import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { LencoService } from './lenco.service';

describe('LencoService', () => {
  const createConfigService = (
    overrides: Partial<Record<string, string | undefined>> = {},
  ): ConfigService => {
    const values: Record<string, string | undefined> = {
      LENCO_API_KEY: 'api-key',
      LENCO_SECRET_KEY: 'secret-key',
      LENCO_ACCOUNT_ID: 'account-id',
      LENCO_WEBHOOK_SECRET: 'webhook-secret',
      LENCO_BASE_URL: 'https://api.lenco.co/access/v2',
      ...overrides,
    };

    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  };

  it('verifies webhook signatures with LENCO_WEBHOOK_SECRET', () => {
    const service = new LencoService(createConfigService());
    service.onModuleInit();

    const payload = JSON.stringify({ event: 'collection.successful' });
    const signature = crypto
      .createHmac('sha512', 'webhook-secret')
      .update(payload)
      .digest('hex');

    expect(service.verifyWebhookSignature(payload, signature)).toBe(true);
  });

  it('returns false when the provided signature is invalid', () => {
    const service = new LencoService(createConfigService());
    service.onModuleInit();

    expect(
      service.verifyWebhookSignature(
        JSON.stringify({ event: 'transfer.successful' }),
        'invalid-signature',
      ),
    ).toBe(false);
  });

  it('returns false when LENCO_WEBHOOK_SECRET is not configured', () => {
    const service = new LencoService(
      createConfigService({ LENCO_WEBHOOK_SECRET: undefined }),
    );
    service.onModuleInit();

    const payload = JSON.stringify({ event: 'collection.successful' });
    const signature = crypto
      .createHmac('sha512', 'webhook-secret')
      .update(payload)
      .digest('hex');

    expect(service.verifyWebhookSignature(payload, signature)).toBe(false);
  });

  it('does not log Lenco payment request or response payload values', async () => {
    const service = new LencoService(createConfigService());
    service.onModuleInit();

    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        status: true,
        data: {
          id: 'collection_secret_123',
          reference: 'REF-SECRET-123',
          status: 'pending',
        },
      }),
    } as unknown as Response);

    try {
      await service.collectMobileMoney({
        amount: 100,
        currency: 'ZMW',
        narration: 'Sensitive order payment',
        phone: '+260977000000',
        operator: 'mtn',
        reference: 'REF-SECRET-123',
        metadata: {
          userId: 'user_secret_123',
        },
      });

      const logOutput = logSpy.mock.calls
        .flatMap((call) => call.map((value) => String(value)))
        .join('\n');

      expect(logOutput).not.toContain('+260977000000');
      expect(logOutput).not.toContain('REF-SECRET-123');
      expect(logOutput).not.toContain('user_secret_123');
      expect(logOutput).not.toContain('collection_secret_123');
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
