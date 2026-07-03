// Wraps async route handlers so unhandled Promise rejections become 500 errors
export const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Global error handler — register LAST in Express
export function errorHandler(err, req, res, _next) {
  console.error('[error]', err.message, err.stack?.split('\n')[1] || '');

  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message }))
    });
  }

  // PostgreSQL unique violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'A record with this value already exists' });
  }

  // PostgreSQL FK violation
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Referenced record does not exist' });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}
