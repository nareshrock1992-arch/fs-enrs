// Zod schema validator middleware
// Usage: router.post('/', validate(MyZodSchema), handler)
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        issues: result.error.errors.map(e => ({
          path:    e.path.join('.'),
          message: e.message,
        }))
      });
    }
    req.body = result.data;  // replace body with parsed/coerced data
    next();
  };
}

// Validate query params
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        issues: result.error.errors.map(e => ({
          path: e.path.join('.'), message: e.message,
        }))
      });
    }
    req.query = result.data;
    next();
  };
}
