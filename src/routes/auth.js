import express from 'express';
import passport from 'passport';
import { requireLogin } from '../middleware/auth.js';

export const authRouter = express.Router();

authRouter.post('/login', (req, res, next) => {
  passport.authenticate('local', (error, user, info) => {
    if (error) return next(error);
    if (!user) return res.status(401).json({ error: info?.code || 'invalid_credentials' });
    return req.logIn(user, (loginError) => {
      if (loginError) return next(loginError);
      return res.json({ user: { id: String(user._id), username: user.username, email: user.email, displayname: user.displayname || null } });
    });
  })(req, res, next);
});

authRouter.post('/logout', requireLogin, (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);
    return req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);
      res.clearCookie('chounaikai.sid');
      return res.status(204).end();
    });
  });
});

authRouter.get('/me', requireLogin, (req, res) => {
  res.json({ user: { id: String(req.user._id), username: req.user.username, email: req.user.email, displayname: req.user.displayname || null, isAdmin: Boolean(req.user.isAdmin) } });
});
