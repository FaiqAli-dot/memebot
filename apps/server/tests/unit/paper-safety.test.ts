import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPaperOnly,
  RealExecutionForbiddenError,
} from '../../src/domain/paper-safety.js';

describe('paper-only safety gate', () => {
  it('allows PAPER with real execution disabled', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'PAPER',
        REAL_EXECUTION_ENABLED: false,
        WALLET_SIGNING_ENABLED: false,
      }),
    ).not.toThrow();
  });

  it('refuses to start when REAL_EXECUTION_ENABLED=true', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'PAPER',
        REAL_EXECUTION_ENABLED: true,
        WALLET_SIGNING_ENABLED: false,
      }),
    ).toThrow(RealExecutionForbiddenError);
  });

  it('refuses to start when WALLET_SIGNING_ENABLED=true', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'PAPER',
        REAL_EXECUTION_ENABLED: false,
        WALLET_SIGNING_ENABLED: true,
      }),
    ).toThrow(RealExecutionForbiddenError);
  });

  it('server source has no transaction signing / submission code path', () => {
    const forbidden =
      /sendTransaction|sendRawTransaction|signTransaction|signAllTransactions|Keypair|secretKey|privateKey|@solana\/web3\.js/;
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && forbidden.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('refuses non-PAPER trading mode', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'LIVE',
        REAL_EXECUTION_ENABLED: false,
        WALLET_SIGNING_ENABLED: false,
      }),
    ).toThrow(RealExecutionForbiddenError);
  });
});
