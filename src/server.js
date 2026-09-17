import 'dotenv/config';
import mongoose from 'mongoose';
import { loadConfig } from './config/env.js';
import { connectDatabase } from './db/connect.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);
mongoose.connection.on('error', error => console.error('MongoDB connection error:', error.message));
mongoose.connection.on('disconnected', () => console.error('MongoDB disconnected.'));
try {
  await connectDatabase(config.mongoUri, config.nodeEnv);
  console.log('MongoDB connected.');
} catch (error) {
  console.error('MongoDB connection failed:', error.message);
  if (config.nodeEnv === 'production') {
    console.error('本番環境ではMongoDBへ接続できないため、サーバーを起動できません。MONGODB_URIを確認してください。');
    process.exitCode = 1;
    throw error;
  }
  console.error('Web server will stay available; database-backed pages will retry when MongoDB is restored.');
}
app.listen(config.port, () => console.log(`chounaikai listening on port ${config.port}`));
