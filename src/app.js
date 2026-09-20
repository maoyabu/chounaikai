import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import passport from 'passport';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurePassport } from './auth/passport.js';
import { authRouter } from './routes/auth.js';
import { associationsRouter } from './routes/associations.js';
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

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const createApp = ({ mongoUri, sessionSecret, nodeEnv = 'development' }) => {
  const app = express();
  app.disable('x-powered-by');
  // Change the asset URL whenever the server starts (or when a release version
  // is provided) so browsers do not keep using stale CSS/JS assets.
  app.locals.assetVersion = process.env.RELEASE_VERSION || String(Date.now());
  if (nodeEnv === 'production') app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.set('view engine', 'ejs');
  app.set('views', path.join(dirname, 'views'));
  app.use('/assets', express.static(path.join(dirname, 'public'), { maxAge: nodeEnv === 'production' ? '1d' : 0 }));
  app.get('/health', (_req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ ok: mongoose.connection.readyState === 1 }));
  // The server connects Mongoose before creating the app. Reuse that client so
  // session reads and application queries share the same monitored connection.
  const storeOptions = mongoose.connection.readyState === 1
    ? { clientPromise: Promise.resolve(mongoose.connection.getClient()) }
    : { mongoUrl: mongoUri };
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

  app.use('/', webRouter);
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
  app.use('/associations', householdsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/associations', associationsRouter);
  app.use((error, req, res, _next) => {
    const databaseUnavailable = ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError'].includes(error?.name)
      || ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(error?.code);
    const status = Number(error.status) || (databaseUnavailable ? 503 : error?.code === 11000 ? 409 : 500);
    if (status >= 500) console.error(error);
    if (!req.originalUrl.startsWith('/api/')) {
      const messages = {
        400: error.message || '入力内容を確認してください。',
        403: 'この操作を行う権限がありません。',
        404: '指定された情報を確認できませんでした。',
        409: error.message || '現在の状態では操作できません。',
        429: error.message || '時間をおいて再度お試しください。',
        503: 'データベースに接続できません。少し待ってから再度お試しください。'
      };
      return res.status(status).render('error', { title: status === 409 ? '操作を完了できません' : 'エラー', message: messages[status] || '処理中にエラーが発生しました。' });
    }
    res.status(status).json({ error: status === 500 ? 'internal_error' : error.message });
  });
  return app;
};
