import mongoose from 'mongoose';
import passportLocalMongoose from 'passport-local-mongoose';

// Compatibility model for the existing `users` collection. Keep this schema to
// shared identity fields only; chounaikai writes must use field-level updates.
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  displayname: String,
  email: { type: String, required: true },
  birth_date: Date,
  entry_date: Date,
  update_date: Date,
  avatar: String,
  blood: String,
  rh: String,
  sex: String,
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  emailVerificationRequired: { type: Boolean, default: false },
  emailVerifiedAt: Date,
  emailVerificationTokenDigest: { type: String, select: false },
  emailVerificationExpires: Date,
  emailVerificationSentAt: Date,
  groups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Group' }],
  defaultGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  unsubscribe_date: Date,
  isAdmin: { type: Boolean, default: false },
  isPlanner: Boolean,
  isMail: Boolean,
  salt: String,
  hash: String
}, {
  collection: 'users',
  strict: true
});

userSchema.plugin(passportLocalMongoose);

export const User = mongoose.models.User || mongoose.model('User', userSchema);
