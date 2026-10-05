import 'dotenv/config';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config/env.js';

let client;
try {
  if (process.env.NODE_ENV !== 'production') throw new Error('Run this check with NODE_ENV=production');
  const config = loadConfig();
  console.log('Production configuration: authenticated MongoDB, verified TLS, allowed DB host and HTTPS origin confirmed.');
  console.log(config.mongoOptions.proxyHost ? 'MongoDB fixed-egress proxy: configured.' : 'MongoDB fixed-egress proxy: not configured. Atlas Network Access still needs a fixed-egress path.');
  if (process.argv.includes('--connect')) {
    client = new mongoose.mongo.MongoClient(config.mongoUri, {
      ...config.mongoOptions, connectTimeoutMS: 10000, serverSelectionTimeoutMS: 10000
    });
    await client.connect();
    await client.db().command({ ping: 1 });
    console.log('MongoDB connectivity: confirmed (read-only ping).');
  }
  console.log('Atlas IP Access List must be checked in Atlas; this command cannot verify its rules.');
} catch (error) {
  // Database/driver error messages may contain connection details. Do not print them.
  console.error(client ? 'MongoDB connectivity check failed. Check the Atlas access list, proxy and TLS settings.' : error.message);
  process.exitCode = 1;
} finally {
  if (client) await client.close();
}
