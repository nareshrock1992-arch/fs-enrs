import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { mkdirSync } from 'fs';
import { requireAuth } from '../../middleware/auth.js';
import { adminOnly, adminOrOp } from '../../middleware/rbac.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { query } from '../../db/pool.js';
import { config } from '../../config/index.js';
import { effectiveTenantId, requireTenantForWrite } from '../../middleware/tenantScope.js';

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
  const tenantFilter = effectiveTenantId(req);
  const { rows } = await query(
    `SELECT m.*, o.name AS organization_name, u.full_name AS uploaded_by_name
     FROM media_files m
     LEFT JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN users u ON u.id = m.uploaded_by_user_id
     WHERE m.deleted_at IS NULL
       AND ($1::int IS NULL OR m.tenant_id = $1)
     ORDER BY m.created_at DESC`,
    [tenantFilter]
  );
  res.json(rows);
}));

const VALID_MEDIA_TYPES = new Set(['RECORDING', 'PROMPT', 'IVR_PROMPT', 'MUSIC', 'OTHER']);

router.post('/upload', adminOnly, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const mediaType = req.body.type || 'PROMPT';
  if (!VALID_MEDIA_TYPES.has(mediaType)) {
    return res.status(400).json({ error: `Invalid type "${mediaType}". Must be one of: ${[...VALID_MEDIA_TYPES].join(', ')}` });
  }
  // Use the deployment controller's upload endpoint instead — it handles
  // FS copy, is_deployed, category, and tenant_id consistently.
  // This route is kept for backwards compatibility (IVR builder file picker).
  const { rows: [record] } = await query(
    `INSERT INTO media_files
       (organization_id, uploaded_by_user_id, type, name, path_or_uri, size_bytes, category, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      req.body.organization_id || null,
      req.user.id,
      mediaType,
      req.file.originalname,
      req.file.path,
      req.file.size,
      req.body.category || 'general',
      requireTenantForWrite(req),
    ]
  );
  res.status(201).json(record);
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  const tenantFilter = effectiveTenantId(req);
  const { rowCount } = await query(
    `UPDATE media_files SET deleted_at = now()
     WHERE id = $1
       AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantFilter]
  );
  if (!rowCount) return res.status(404).json({ error: 'Media not found or access denied' });
  res.status(204).end();
}));

export default router;
