import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdmin } from '../../auth/guard.js';
import type { Container } from '../../server/container.js';

const registerBody = z.object({
  home_domain: z.string().min(1).max(253),
});

export function registerAnchorRoutes(app: FastifyInstance, c: Container): void {
  app.get('/v1/anchors', {
    schema: { tags: ['anchors'], summary: 'List registered anchors with discovered endpoints and assets' },
  }, async () => c.anchors.list());

  app.get('/v1/anchors/:id', {
    schema: { tags: ['anchors'], summary: 'Get one anchor' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.anchors.getById(id);
  });

  app.post('/v1/anchors', {
    schema: {
      tags: ['anchors'],
      summary: 'Register an anchor by home domain (runs SEP-1 discovery)',
      body: { type: 'object', required: ['home_domain'], properties: { home_domain: { type: 'string' } } },
    },
    preHandler: [requireAdmin],
  }, async (req) => {
    const body = registerBody.parse(req.body);
    return c.anchors.register(body.home_domain, req.session?.sub);
  });
}