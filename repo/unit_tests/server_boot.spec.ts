/**
 * Coverage for `src/server.ts`.
 *
 * The file is a short IIFE that (a) connects to Prisma, (b) starts the
 * scheduler, (c) starts the HTTP listener, and (d) `process.exit(1)`s on
 * DB failure. Both branches are covered by re-importing the module
 * inside `jest.isolateModules` with the critical dependencies stubbed.
 */

describe('server.ts main()', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_c?: number) => undefined as never) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('happy path: connects, starts scheduler, calls listen', async () => {
    let startSchedulerMock: jest.Mock | undefined;
    let listenMock: jest.Mock | undefined;
    await new Promise<void>((resolve) => {
      jest.isolateModules(() => {
        startSchedulerMock = jest.fn();
        listenMock = jest.fn((_p: number, cb: () => void) => cb && cb());
        jest.doMock('../src/services/scheduler.service', () => ({
          __esModule: true,
          startScheduler: startSchedulerMock,
        }));
        jest.doMock('../src/app', () => ({
          __esModule: true,
          default: { listen: listenMock },
        }));
        const { getPrisma } = require('../src/config/database');
        const prisma = getPrisma();
        prisma.$connect = jest.fn().mockResolvedValue(undefined);
        require('../src/server');
        setImmediate(resolve);
      });
    });
    // Let async main() settle.
    await new Promise((r) => setImmediate(r));
    expect(startSchedulerMock).toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalled();
  });

  it('failure path: process.exit(1) when DB connect fails', async () => {
    await new Promise<void>((resolve) => {
      jest.isolateModules(() => {
        jest.doMock('../src/services/scheduler.service', () => ({
          __esModule: true,
          startScheduler: jest.fn(),
        }));
        jest.doMock('../src/app', () => ({
          __esModule: true,
          default: { listen: jest.fn() },
        }));
        const { getPrisma } = require('../src/config/database');
        const prisma = getPrisma();
        prisma.$connect = jest.fn().mockRejectedValue(new Error('db unavailable'));
        require('../src/server');
        setImmediate(resolve);
      });
    });
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
