import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { mkdirSync } from 'fs';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';
import { config } from '../../config/index.js';

// Ensure upload directory exists
mkdirSync(config.uploads.dir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploads.dir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: config.uploads.maxSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.wav', '.mp3', '.ogg', '.gsm', '.ul'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
  },
});

const router = Router();
router.use(requireAuth);

router.get('/', adminOrOp, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, o.name AS organization_name, u.full_name AS uploaded_by_name
     FROM media_files m
     LEFT JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     WHERE m.deleted_at IS NULL
       AND ($1::int IS NULL OR m.organization_id = $1)
     ORDER BY m.created_at DESC`,
    [req.query.organization_id || null]
  );
  res.json(rows);
}));

router.post('/upload', adminOnly, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { rows } = await query(
    `INSERT INTO media_files
       (organization_id, uploaded_by_user_id, type, name, path_or_uri, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.body.organization_id, req.user.id, req.body.type || 'RECORDING',
     req.file.originalname, req.file.path, req.file.size]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  await query(`UPDATE media_files SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
}));

export default router;
