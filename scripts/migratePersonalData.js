import 'dotenv/config';
import mongoose from 'mongoose';
import { personalDataKeyring } from '../src/security/personalDataCrypto.js';
import { migratePersonalData } from '../src/security/personalDataMigration.js';
import { mongoProxyOptions, mongoSecurityOptions } from '../src/config/security.js';

let client;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run', '--rotate', '--maintenance-confirmed'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) throw new Error('Use --dry-run, or --apply --maintenance-confirmed; optionally --rotate');
  const apply = args.includes('--apply'), rotate = args.includes('--rotate');
  if (apply && !args.includes('--maintenance-confirmed')) throw new Error('Stop application writes and take a backup before using --apply --maintenance-confirmed');
  const ring = personalDataKeyring();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  client = new mongoose.mongo.MongoClient(uri, {
    ...mongoSecurityOptions(uri, process.env.NODE_ENV || 'development', { allowedHosts: process.env.MONGODB_ALLOWED_HOSTS, caFile: process.env.MONGODB_TLS_CA_FILE }),
    ...mongoProxyOptions(process.env.MONGODB_SOCKS_PROXY_URL || process.env.FIXIE_SOCKS_HOST),
    serverSelectionTimeoutMS: 10000
  });
  await client.connect();
  if (apply) {
    const preflight = await migratePersonalData(client.db(), { rotate, ring });
    if (Object.values(preflight).some(stats => stats.invalidFields)) {
      console.log(JSON.stringify({ apply: false, preflightFailed: true, collections: preflight }, null, 2));
      throw new Error('preflight_failed');
    }
  }
  const result = await migratePersonalData(client.db(), { apply, rotate, ring });
  // Counts only; no identifiers, personal values, keys or connection URLs.
  console.log(JSON.stringify({ apply, rotate, collections: result }, null, 2));
  if (Object.values(result).some(stats => stats.invalidFields || stats.conflicts)) process.exitCode = 1;
} catch {
  console.error('Personal data migration failed. Check keys, database settings and maintenance flags. No personal values are logged.');
  process.exitCode = 1;
} finally { if (client) await client.close(); }
