import type { Db } from '../db/client.js';
import { createJwtService, type JwtService } from '../auth/jwt.js';
import type { Logger } from '../lib/logger.js';
import { createStellarTomlService } from '../modules/sep1/StellarTomlService.js';
import { createAnchorService, type AnchorService } from '../modules/anchors/AnchorService.js';
import { createSep10Service, type Sep10Service } from '../modules/sep10/Sep10Service.js';
import { createSep24Service, type Sep24Service } from '../modules/sep24/Sep24Service.js';
import { createSep6Service, type Sep6Service } from '../modules/sep6/Sep6Service.js';
import { createHorizonService, type HorizonService } from '../modules/horizon/HorizonService.js';
import { createLocalSigningService, type SigningService } from '../modules/signing/SigningService.js';
import { createQuoteService, type QuoteService } from '../modules/quotes/QuoteService.js';
import { createPathPaymentService, type PathPaymentService } from '../modules/pathPayments/PathPaymentService.js';
import { createSorobanService, type SorobanService } from '../modules/soroban/SorobanService.js';
import {
  createRemittanceService,
  type RemittanceService,
} from '../modules/remittance/RemittanceService.js';
import { createJobManager, type JobManager } from '../modules/remittance/jobs.js';
import { PaymentStreamer } from '../modules/horizon/PaymentStreamer.js';
import { Reconciler } from '../modules/horizon/Reconciler.js';

export interface Container {
  db: Db;
  logger: Logger;
  jwt: JwtService;
  toml: ReturnType<typeof createStellarTomlService>;
  anchors: AnchorService;
  sep10: Sep10Service;
  sep24: Sep24Service;
  sep6: Sep6Service;
  horizon: HorizonService;
  signing: SigningService;
  quotes: QuoteService;
  pathPayments: PathPaymentService;
  soroban: SorobanService;
  remittance: RemittanceService;
  jobs: JobManager;
  streamer: PaymentStreamer;
  reconciler: Reconciler;
}

/**
 * Build the full service graph. Throws eagerly on misconfiguration
 * (missing CONTRACT_ID, role secrets, etc.) so the process fails fast.
 */
export function buildContainer(db: Db, logger: Logger): Container {
  const jwt = createJwtService();
  const toml = createStellarTomlService();
  const anchors = createAnchorService(db, toml);
  const sep10 = createSep10Service(jwt);
  const sep24 = createSep24Service(db);
  const sep6 = createSep6Service(db);
  const horizon = createHorizonService();
  const signing = createLocalSigningService();
  const quotes = createQuoteService(db);
  const pathPayments = createPathPaymentService(db, horizon, signing);
  const soroban = createSorobanService(db);
  const remittance = createRemittanceService(db, quotes, soroban);

  const jobs = createJobManager(
    db,
    { remittance, soroban, sep24, sep6 },
    logger,
  );

  const streamer = new PaymentStreamer(db, horizon, async (events) => {
    for (const event of events) {
      // Route events to remittances whose sender/recipient account matches.
      const { remittancesForAccount } = await import('../modules/horizon/payments.js');
      const ids = await remittancesForAccount(db, event.account);
      for (const id of ids) {
        await jobs.enqueuePaymentEvent(id, event);
      }
    }
  }, logger);

  const reconciler = new Reconciler(db, horizon, async (events) => {
    for (const event of events) {
      const { remittancesForAccount } = await import('../modules/horizon/payments.js');
      const ids = await remittancesForAccount(db, event.account);
      for (const id of ids) {
        await jobs.enqueuePaymentEvent(id, event);
      }
    }
  }, logger);

  return {
    db,
    logger,
    jwt,
    toml,
    anchors,
    sep10,
    sep24,
    sep6,
    horizon,
    signing,
    quotes,
    pathPayments,
    soroban,
    remittance,
    jobs,
    streamer,
    reconciler,
  };
}