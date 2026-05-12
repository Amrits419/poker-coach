import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { email, username } = req.body as { email: string; username: string };

  if (!email || !username) {
    res.status(400).json({ error: 'email and username required' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.json(existing);
    return;
  }

  const user = await prisma.user.create({ data: { email, username } });
  res.status(201).json(user);
});

router.get('/:id', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

export default router;
