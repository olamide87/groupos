import 'dotenv/config';
import { app } from './app.js';

const port = Number(process.env.PORT ?? 4100);
app.listen(port, () => console.log(`GroupOS API listening on port ${port}`));
