import { mkdirSync } from 'fs';
import { join } from 'path';

// Processed JPEGs live here and are served publicly at /media/* so Meta can fetch them.
export const UPLOAD_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });
