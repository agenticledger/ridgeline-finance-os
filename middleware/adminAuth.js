const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Stable signing key — deterministic from env or from password hash
// Unlike a random per-process secret, this survives server restarts
const SIGNING_KEY = process.env.ADMIN_SIGNING_KEY ||
  crypto.createHash('sha256').update(ADMIN_PASSWORD + '-orphil-admin').digest('hex');

function generateToken() {
  return crypto.createHmac('sha256', SIGNING_KEY)
    .update(ADMIN_PASSWORD)
    .digest('hex');
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-key'];
  if (!token || token !== generateToken()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireAdmin, generateToken, ADMIN_PASSWORD };
