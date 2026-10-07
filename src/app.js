import { messageAttachmentsRouter } from './routes/messageAttachments.js';
import express from 'express';
import { legalRouter } from './routes/legal.js';
import { mfaEncryptionKey } from './config/mfa.js';
import { createMfaService } from './services/mfaService.js';
import { enforceAdminMfa } from './middleware/mfa.js';
import { mfaRouter } from './routes/mfa.js';
import { privacyAudit } from './middleware/privacyAudit.js';
import { privacyAuditRouter } from './routes/privacyAudit.js';
import { createSiteSecurityService, applySiteMfaPolicy } from './services/siteSecurityService.js';
import { siteSecurityRouter } from './routes/siteSecurity.js';
import { productionErrorResponses, applicationErrorHandler } from './middleware/errorResponses.js';
import { securityHeaders, enforceHttps } from './middleware/security.js';
import { createAuthRateLimiter, createMemoryRateStore, createMongoRateStore } from './middleware/authRateLimit.js';
import { mongoSecurityOptions } from './config/security.js';
import { systemContactsRouter } from './routes/systemContacts.js';
import { documentsRouter } from './routes/documents.js';
import { equipmentRouter } from './routes/equipment.js';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import passport from 'passport';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurePassport } from './auth/passport.js';
import { authRouter } from './routes/auth.js';
import { associationsRouter } from './routes/associations.js';
import { disclosureRouter } from './routes/disclosure.js';
import { webRouter } from './routes/web.js';
import { managementRouter } from './routes/management.js';
import { householdsRouter } from './routes/households.js';
import { householdInvitationsRouter } from './routes/householdInvitations.js';
import { withdrawalsRouter } from './routes/withdrawals.js';
import { questionBoxRouter } from './routes/questionBox.js';
import { officerAnnouncementsRouter } from './routes/officerAnnouncements.js';
import { officerNetworkRouter } from './routes/officerNetwork.js';
import { districtMessagesRouter } from './routes/districtMessages.js';
import { associationEventsRouter } from './routes/associationEvents.js';
import { associationGroupsRouter } from './routes/associationGroups.js';
import { associationFinanceRouter } from './routes/associationFinance.js';
import { notificationsRouter } from './routes/notifications.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const createApp = ({ mongoUri, sessionSecret, nodeEnv = 'development', publicBaseUrl = process.env.PUBLIC_BASE_URL, trustProxy = nodeEnv === 'production' ? 1 : false, mongoOptions = {}, rateLimitStore, mfaService, mfaKey = process.env.MFA_ENCRYPTION_KEY, privacyAuditWriter, siteSecurityService }) => {
  const app = express();
  app.disable('x-powered-by');
  app.set('env', nodeEnv);
  app.use(productionErrorResponses(nodeEnv));
  app.locals.siteSecurityService = siteSecurityService || createSiteSecurityService();
  app.locals.mfaService = applySiteMfaPolicy(mfaService || createMfaService({ key: mfaEncryptionKey(mfaKey, sessionSecret, nodeEnv) }), app.locals.siteSecurityService);
  // Change the asset URL whenever the server starts (or when a release version
  // is provided) so browsers do not keep using stale CSS/JS assets.
  app.locals.assetVersion = process.env.RELEASE_VERSION || String(Date.now());
  app.set('trust proxy', trustProxy);
  const secureMongoOptions = { ...mongoOptions, ...mongoSecurityOptions(mongoUri, nodeEnv, { caFile: mongoOptions.tlsCAFile, allowedHosts: process.env.MONGODB_ALLOWED_HOSTS }) };
  app.use(securityHeaders(nodeEnv));
  app.use(enforceHttps(nodeEnv, publicBaseUrl));
  app.use((_req, res, next) => { res.locals.currentUser = null; res.locals.showNotificationPrompt = false; next(); });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  const limiterStore = rateLimitStore || (nodeEnv === 'production' ? createMongoRateStore() : createMemoryRateStore());
  app.use(createAuthRateLimiter({ store: limiterStore, secret: sessionSecret }));
  app.set('view engine', 'ejs');
  app.set('views', path.join(dirname, 'views'));
  app.use('/assets', express.static(path.join(dirname, 'public'), { maxAge: nodeEnv === 'production' ? '1d' : 0 }));
  app.get('/health', (_req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ ok: mongoose.connection.readyState === 1 }));
  // Public legal pages remain available without a session or MFA verification.
  app.use('/', legalRouter);
  // The server connects Mongoose before creating the app. Reuse that client so
  // session reads and application queries share the same monitored connection.
  const storeOptions = mongoose.connection.readyState === 1
    ? { clientPromise: Promise.resolve(mongoose.connection.getClient()) }
    : { mongoUrl: mongoUri, mongoOptions: secureMongoOptions };
  const sessionStore = MongoStore.create({ ...storeOptions, collectionName: 'chounaikai_sessions', touchAfter: 3600 });
  app.use(session({
    name: 'chounaikai.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: nodeEnv === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  }));
  configurePassport(passport);
  app.use(passport.initialize());
  app.use(passport.session());
  app.use((req, res, next) => {
    res.locals.currentUser = req.user || null;
    res.locals.showNotificationPrompt = Boolean(req.user && req.session.notificationPromptPending);
    next();
  });

  app.use(createAuthRateLimiter({ store: limiterStore, secret: sessionSecret, authenticated: true }));
  app.use(enforceAdminMfa(app.locals.mfaService));
  app.use(privacyAudit({ writer: privacyAuditWriter }));
  app.use('/mfa', mfaRouter);
  app.use('/api/auth/mfa', mfaRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/', webRouter);
  // Disclosure views need the navigation and flash locals initialized by webRouter.
  app.use('/', disclosureRouter);
  app.use('/', privacyAuditRouter);
  app.use('/', siteSecurityRouter);
  app.use('/', systemContactsRouter);
  app.use('/associations', messageAttachmentsRouter);
  app.use('/associations', associationEventsRouter);
  app.use('/associations', associationGroupsRouter);
  app.use('/associations', associationFinanceRouter);
  app.use('/', householdInvitationsRouter);
  app.use('/', withdrawalsRouter);
  app.use('/associations', questionBoxRouter);
  app.use('/associations', officerAnnouncementsRouter);
  app.use('/associations', officerNetworkRouter);
  app.use('/associations', districtMessagesRouter);
  app.use('/associations', managementRouter);
  app.use('/associations', equipmentRouter);
  app.use('/associations', documentsRouter);
  app.use('/associations', householdsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/associations', associationsRouter);
  app.use((_req, _res, next) => next(Object.assign(new Error('not_found'), { status: 404 })));
  app.use(applicationErrorHandler(nodeEnv));
  return app;
};
