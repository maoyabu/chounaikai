import 'dotenv/config';
import { runEquipmentReminders } from './services/equipmentService.js';
import mongoose from 'mongoose';
import { loadConfig } from './config/env.js';
import { connectDatabase } from './db/connect.js';
import { createApp } from './app.js';
import { deleteExpiredAnnouncementAttachments } from './services/announcementAttachmentService.js';
import { AnnualOfficer } from './models/annualOfficer.js';
import { dispatchPendingNotifications } from './services/notificationService.js';

const config = loadConfig();
mongoose.connection.on('error', error => console.error('MongoDB connection error:', error.message));
mongoose.connection.on('disconnected', () => console.error('MongoDB disconnected.'));
try {
  await connectDatabase(config.mongoUri, config.nodeEnv, config.mongoOptions);
  console.log('MongoDB connected.');
  let notificationDispatchRunning = false;
  setInterval(async () => {
    if (notificationDispatchRunning) return;
    notificationDispatchRunning = true;
    try { await dispatchPendingNotifications(); }
    catch (error) { console.error('Notification dispatch failed:', error.name); }
    finally { notificationDispatchRunning = false; }
  }, 10000).unref();
  // 旧バージョンの user 一意インデックスが残っていると、会員未紐付け
  // （user=null）の役員を複数登録できないため、スキーマ定義に合わせて同期する。
  try { await AnnualOfficer.syncIndexes(); } catch (error) { console.error('Annual officer indexes could not be synchronized:', error.message); }
  let equipmentRemindersRunning = false;
  const equipmentReminders = async () => {
    if (equipmentRemindersRunning) return;
    equipmentRemindersRunning = true;
    try { await runEquipmentReminders(); }
    catch (error) { console.error('Equipment reminders failed:', error.message); }
    finally { equipmentRemindersRunning = false; }
  };
  await equipmentReminders();
  setInterval(equipmentReminders, 60 * 60 * 1000).unref();
  const cleanupExpiredAttachments = async () => {
    try {
      const count = await deleteExpiredAnnouncementAttachments();
      if (count) console.log(`Deleted ${count} expired announcement attachment(s).`);
    } catch (error) { console.error('Expired announcement attachment cleanup failed:', error.message); }
  };
  await cleanupExpiredAttachments();
  setInterval(cleanupExpiredAttachments, 60 * 60 * 1000).unref();
} catch (error) {
  console.error('MongoDB connection failed:', error.message);
  if (config.nodeEnv === 'production') {
    console.error('本番環境ではMongoDBへ接続できないため、サーバーを起動できません。MONGODB_URIを確認してください。');
    process.exitCode = 1;
    throw error;
  }
  console.error('Web server will stay available; database-backed pages will retry when MongoDB is restored.');
}
const app = createApp(config);
app.listen(config.port, () => console.log(`chounaikai listening on port ${config.port}`));
