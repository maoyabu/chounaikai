import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/db/connect.js';
import { User } from '../src/models/user.js';
import { Group } from '../src/models/group.js';

// Read-only preflight. This script intentionally contains no insert/update/delete.
const mongoUri = String(process.env.MONGODB_URI || '').trim();
if (!mongoUri) throw new Error('MONGODB_URI is required');
await connectDatabase(mongoUri, process.env.NODE_ENV || 'development');

try {
  const [userCount, groupCount, missingFromGroup, missingFromUser, duplicateEmails, duplicateUsernames] = await Promise.all([
    User.countDocuments({}),
    Group.countDocuments({}),
    User.aggregate([
      { $unwind: { path: '$groups', preserveNullAndEmptyArrays: false } },
      { $lookup: { from: 'groups', localField: 'groups', foreignField: '_id', as: 'group' } },
      { $match: { group: { $size: 0 } } },
      { $count: 'count' }
    ]),
    Group.aggregate([
      { $unwind: { path: '$members', preserveNullAndEmptyArrays: false } },
      { $lookup: { from: 'users', localField: 'members', foreignField: '_id', as: 'user' } },
      { $match: { user: { $size: 0 } } },
      { $count: 'count' }
    ]),
    User.aggregate([
      { $match: { email: { $type: 'string' } } },
      { $group: { _id: { $toLower: '$email' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'count' }
    ]),
    User.aggregate([
      { $group: { _id: '$username', count: { $sum: 1 } } },
      { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
      { $count: 'count' }
    ])
  ]);

  console.log(JSON.stringify({
    readOnly: true,
    userCount,
    groupCount,
    danglingUserGroupReferences: missingFromGroup[0]?.count || 0,
    danglingGroupMemberReferences: missingFromUser[0]?.count || 0,
    caseInsensitiveDuplicateEmailSets: duplicateEmails[0]?.count || 0,
    duplicateUsernameSets: duplicateUsernames[0]?.count || 0
  }, null, 2));
} finally {
  await disconnectDatabase();
}
