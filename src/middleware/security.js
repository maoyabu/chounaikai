import helmet from 'helmet';
import { publicHttpsOrigin } from '../config/security.js';

export const securityHeaders = nodeEnv => helmet({
  // Existing EJS pages use inline scripts and event attributes. Keep these working
  // while restricting external scripts, frames, forms and connection destinations.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://zipcloud.ibsnet.co.jp'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: nodeEnv === 'production' ? [] : null
    }
  },
  // Served by the HTTPS middleware only, after the transport is verified.
  strictTransportSecurity: false,
  referrerPolicy: { policy: 'no-referrer' },
  xFrameOptions: { action: 'sameorigin' },
  // Uploaded images may be hosted on external sites without CORP headers.
  crossOriginEmbedderPolicy: false
});

export const enforceHttps = (nodeEnv, publicBaseUrl) => {
  if (nodeEnv !== 'production') return (_req, _res, next) => next();
  const origin = publicHttpsOrigin(publicBaseUrl);
  const hsts = helmet.strictTransportSecurity({ maxAge: 31536000, includeSubDomains: false, preload: false });
  return (req, res, next) => {
    if (req.secure) return hsts(req, res, next);
    // Use a configured origin, never Host/X-Forwarded-Host supplied by the client.
    // Concatenation also keeps paths beginning with // on our own origin.
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, `${origin}${req.originalUrl}`);
    return res.status(400).type('text/plain').send('HTTPSで画面を開き直してから、再度操作してください。');
  };
};
