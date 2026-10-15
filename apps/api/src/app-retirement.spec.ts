import { ConfigModule, type ConfigModuleOptions } from '@nestjs/config';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { ConvexModule } from './convex/convex.module';
import { HealthController } from './health/health.controller';
import { PaymentsModule } from './payments/payments.module';
import configuration from './config/configuration';

const originalForRoot = ConfigModule.forRoot.bind(ConfigModule);
const configCalls: ConfigModuleOptions[] = [];
// Isolate only the environment boundary before importing AppModule. Keep the real ConfigModule/container,
// but never load .env, read process.env, invoke the private configuration factory or mutate host env values.
const configBoundary = jest
  .spyOn(ConfigModule, 'forRoot')
  .mockImplementation((options = {}) => {
    configCalls.push(options);

    return originalForRoot({
      isGlobal: options.isGlobal,
      ignoreEnvFile: true,
      ignoreEnvVars: true,
      skipProcessEnv: true,
      load: [() => ({})],
    });
  });
const { AppModule } =
  jest.requireActual<typeof import('./app.module')>('./app.module');
const retired = [
  'AiModule',
  'PaymentsModule',
  'ConvexModule',
  'AiController',
  'PaymentsController',
  'WalletController',
  'ConvexService',
  'LencoService',
  'AiService',
  'RecommendationsService',
  'MessageRephraseService',
  'DisputeAnalysisService',
  'ChatService',
  'ListingModerationService',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function registrationName(value: unknown): string | undefined {
  if (typeof value === 'function') {
    return value.name;
  }
  if (isRecord(value)) {
    return registrationName(value.provide);
  }

  return undefined;
}

async function graphNames(
  value: unknown,
  seen = new Set<unknown>(),
): Promise<Set<string>> {
  const entry: unknown = await value;
  const names = new Set<string>();
  if (seen.has(entry)) {
    return names;
  }
  seen.add(entry);
  const target = isRecord(entry) ? entry.module : entry;
  if (typeof target !== 'function') {
    throw new Error('Expected an actual Nest module in AppModule graph');
  }
  names.add(target.name);

  for (const kind of [MODULE_METADATA.CONTROLLERS, MODULE_METADATA.PROVIDERS]) {
    const registrations: unknown = Reflect.getMetadata(kind, target);
    if (Array.isArray(registrations)) {
      for (const registration of registrations) {
        const name = registrationName(registration);
        if (name) {
          names.add(name);
        }
      }
    }
  }
  const staticImports: unknown = Reflect.getMetadata(
    MODULE_METADATA.IMPORTS,
    target,
  );
  const dynamicImports = isRecord(entry) ? entry.imports : undefined;
  for (const imports of [staticImports, dynamicImports]) {
    if (Array.isArray(imports)) {
      for (const imported of imports) {
        for (const name of await graphNames(imported, seen)) {
          names.add(name);
        }
      }
    }
  }

  return names;
}

async function requireRetiredGraph(): Promise<Set<string>> {
  const names = await graphNames(AppModule);
  const found = retired.filter((name) => names.has(name));
  if (found.length > 0) {
    // Fail before compilation: legacy provider constructors must never run just to prove retirement RED.
    throw new Error(`Legacy runtime registered: ${found.join(', ')}`);
  }

  return names;
}

afterAll(() => {
  configBoundary.mockRestore();
});

test('actual AppModule graph and compiled container contain only retained root/health runtime', async () => {
  const names = await requireRetiredGraph();
  for (const name of [
    'AppModule',
    'AppController',
    'AppService',
    'HealthModule',
    'HealthController',
    'ConfigModule',
  ]) {
    expect(names.has(name)).toBe(true);
  }
  expect(configCalls).toHaveLength(1);
  expect(configCalls[0]).toEqual({ isGlobal: true, load: [configuration] });

  const app = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  try {
    await app.init();
    const container = app.get(ModulesContainer);
    for (const module of container.values()) {
      expect(retired).not.toContain(module.metatype.name);
      for (const wrapper of [
        ...module.controllers.values(),
        ...module.providers.values(),
      ]) {
        expect(retired).not.toContain(wrapper.name);
      }
    }
    expect(app.get(AppController).getHello()).toBe('Hello World!');
    const health = app.get(HealthController);
    expect(health.check()).toEqual({
      status: 'ok',
      service: 'gettitonline-api',
      version: '1.0.0',
      timestamp: expect.any(String),
    });
    expect(health.ready()).toEqual({
      status: 'ready',
      timestamp: expect.any(String),
    });
    expect(health.live()).toEqual({
      status: 'live',
      timestamp: expect.any(String),
    });
  } finally {
    await app.close();
  }
});

for (const obsolete of [AiModule, PaymentsModule, ConvexModule]) {
  test(`restoring ${obsolete.name} alone to actual AppModule fails before provider initialization`, async () => {
    const imports: unknown = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    );
    if (!Array.isArray(imports)) {
      throw new Error('Actual AppModule imports metadata missing');
    }
    // Memory-only counterfactual. Real obsolete module definitions are used; no graph/module mocks.
    Reflect.defineMetadata(
      MODULE_METADATA.IMPORTS,
      [...imports, obsolete],
      AppModule,
    );
    try {
      await expect(requireRetiredGraph()).rejects.toThrow(
        `Legacy runtime registered:`,
      );
      expect((await graphNames(AppModule)).has(obsolete.name)).toBe(true);
    } finally {
      Reflect.defineMetadata(MODULE_METADATA.IMPORTS, imports, AppModule);
    }
  });
}
