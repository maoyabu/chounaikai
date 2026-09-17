import { Strategy as LocalStrategy } from 'passport-local';
import { User } from '../models/user.js';

export const configurePassport = (passport) => {
  passport.use(new LocalStrategy({ usernameField: 'identifier' }, async (identifier, password, done) => {
    try {
      const value = String(identifier || '').trim();
      const email = value.toLowerCase();
      const user = await User.findOne(value.includes('@') ? { email } : { username: value });
      if (!user || user.unsubscribe_date) return done(null, false);
      if (user.emailVerificationRequired && !user.emailVerifiedAt) {
        return done(null, false, { code: 'email_not_verified' });
      }

      user.authenticate(password, (error, authenticatedUser, passwordError) => {
        if (error) return done(error);
        if (passwordError || !authenticatedUser) return done(null, false);
        return done(null, authenticatedUser);
      });
    } catch (error) {
      return done(error);
    }
  }));

  // Unlike the two legacy applications, sessions always contain the immutable
  // MongoDB ObjectId, not username or email.
  passport.serializeUser((user, done) => done(null, String(user._id)));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      if (!user || user.unsubscribe_date) return done(null, false);
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  });
};
