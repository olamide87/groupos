import express from 'express';
import cors from 'cors';

export const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'groupos-api' });
});

app.get('/api/v1', (_req, res) => {
  res.json({ name: 'GroupOS', version: '0.1.0', status: 'foundation' });
});
