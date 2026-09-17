import mongoose from 'mongoose';
import { HouseholdMember } from '../models/organization.js';

const ensureHouseholdMemberUserIndex = async () => {
  const collection = HouseholdMember.collection;
  const indexName = 'association_1_household_1_user_1';
  let indexes = [];
  try { indexes = await collection.indexes(); } catch (error) {
    if (error?.code !== 26) throw error;
  }
  const existing = indexes.find((index) => index.name === indexName);
  if (existing && !existing.partialFilterExpression) {
    try { await collection.dropIndex(indexName); } catch (error) {
      if (error?.code !== 27) throw error;
    }
  }
  await collection.createIndex(
    { association: 1, household: 1, user: 1 },
    { name: indexName, unique: true, partialFilterExpression: { user: { $type: 'objectId' } } }
  );
};

export const connectDatabase = async (mongoUri, nodeEnv = 'development') => {
  mongoose.set('autoIndex', nodeEnv !== 'production');
  await mongoose.connect(mongoUri, { connectTimeoutMS: 10000, serverSelectionTimeoutMS: 10000 });
  // Household members do not need a shared login account. Upgrade the former
  // required-user index so multiple account-less family members can coexist.
  await ensureHouseholdMemberUserIndex();
  return mongoose.connection;
};

export const disconnectDatabase = () => mongoose.disconnect();
