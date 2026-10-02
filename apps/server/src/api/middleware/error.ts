import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../utils/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    return;
  }
  logger.error({ err }, 'Unhandled API error');
  res.status(500).json({ error: 'Internal server error' });
};

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};
