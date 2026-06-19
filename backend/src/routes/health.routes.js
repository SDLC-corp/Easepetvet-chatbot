import { Router } from 'express';

// Liveness endpoint. Only receives the request and returns a response; no
// business logic or data access here.

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
