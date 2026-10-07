import { WalletController } from './wallet.controller';
import {
  type WithdrawToBankDto,
  type WithdrawToMobileMoneyDto,
} from './dto/wallet.dto';

describe('WalletController', () => {
  const serializeConsoleCalls = (
    spies: Array<jest.SpyInstance<void, unknown[]>>,
  ): string =>
    spies
      .flatMap((spy) =>
        spy.mock.calls.flatMap((call) =>
          call.map((value: unknown) =>
            typeof value === 'string' ? value : JSON.stringify(value),
          ),
        ),
      )
      .join('\n');

  const createController = () => {
    const lencoService = {
      isConfigured: jest.fn(() => true),
      transferToMobileMoney: jest.fn(),
      transferToBank: jest.fn(),
    };

    const convexService = {
      getWalletBalance: jest.fn().mockResolvedValue({
        hasWallet: true,
        isFrozen: false,
        balance: 500,
      }),
      debitWallet: jest.fn().mockResolvedValue({
        reference: 'wallet_ref_secret',
        newBalance: 400,
      }),
      updateWalletTransactionExternal: jest.fn().mockResolvedValue(undefined),
      updateWalletWithdrawalStatus: jest.fn().mockResolvedValue(undefined),
    };

    return {
      controller: new WalletController(
        lencoService as never,
        convexService as never,
      ),
      lencoService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not log mobile money withdrawal request or response identifiers', async () => {
    const { controller, lencoService } = createController();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const dto: WithdrawToMobileMoneyDto = {
      userId: 'user_secret_123',
      amount: 100,
      phone: '260977000000',
      provider: 'mtn',
    };

    lencoService.transferToMobileMoney.mockResolvedValue({
      data: {
        id: 'lenco_transfer_secret',
        status: 'pending',
      },
    });

    try {
      await controller.withdrawToMobileMoney(dto);

      const logOutput = serializeConsoleCalls([logSpy, errorSpy]);

      expect(logOutput).not.toContain('260977000000');
      expect(logOutput).not.toContain('wallet_ref_secret');
      expect(logOutput).not.toContain('lenco_transfer_secret');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not log bank withdrawal request or response identifiers', async () => {
    const { controller, lencoService } = createController();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const dto: WithdrawToBankDto = {
      userId: 'user_secret_456',
      amount: 100,
      bankCode: '001',
      accountNumber: '1234567890',
      accountName: 'Sensitive Account Name',
    };

    lencoService.transferToBank.mockResolvedValue({
      data: {
        id: 'lenco_bank_transfer_secret',
        status: 'pending',
      },
    });

    try {
      await controller.withdrawToBank(dto);

      const logOutput = serializeConsoleCalls([logSpy, errorSpy]);

      expect(logOutput).not.toContain('1234567890');
      expect(logOutput).not.toContain('Sensitive Account Name');
      expect(logOutput).not.toContain('wallet_ref_secret');
      expect(logOutput).not.toContain('lenco_bank_transfer_secret');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
