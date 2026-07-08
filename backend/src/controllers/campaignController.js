import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  createCampaignByConfigId,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  getEngineStats,
} from '../services/campaignEngine.js';

const TriggerSchema = z.object({
  ens_configuration_id: z.number().int().positive(),
  message_audio_url:    z.string().optional().nullable(),
  message_text:         z.string().optional().nullable(),
  scheduled_at:         z.string().datetime({ offset: true }).optional().nullable(),
});

// GET /api/v1/campaigns
export const listCampaigns = asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const configId = req.query.ens_configuration_id || null;

  const { rows } = await query(
    `SELECT c.*,
       cfg.name AS ens_name,
       u.full_name AS triggered_by_name,
       o.name AS organization_name
     FROM ens_campaigns c
     LEFT JOIN ens_configurations cfg ON cfg.id = c.ens_configuration_id
     LEFT JOIN users u ON u.id = c.triggered_by
     LEFT JOIN organizations o ON o.id = c.organization_id
     WHERE ($1::text IS NULL OR c.status = $1)
       AND ($2::int  IS NULL OR c.ens_configuration_id = $2)
     ORDER BY c.created_at DESC
     LIMIT $3 OFFSET $4`,
    [status, configId, limit, offset]
  );

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM ens_campaigns
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::int  IS NULL OR ens_configuration_id = $2)`,
    [status, configId]
  );

  res.json({ campaigns: rows, total: cnt[0].total, page, limit });
});

// GET /api/v1/campaigns/:id
export const getCampaign = asyncHandler(async (req, res) => {
  const { rows: [c] } = await query(
    `SELECT c.*,
       cfg.name AS ens_name,
       u.full_name AS triggered_by_name,
       o.name AS organization_name
     FROM ens_campaigns c
     LEFT JOIN ens_configurations cfg ON cfg.id = c.ens_configuration_id
     LEFT JOIN users u ON u.id = c.triggered_by
     LEFT JOIN organizations o ON o.id = c.organization_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  // Destination summary
  const { rows: summary } = await query(
    `SELECT status, COUNT(*)::INT AS count
     FROM ens_campaign_destinations
     WHERE campaign_id = $1
     GROUP BY status`,
    [req.params.id]
  );

  res.json({ ...c, destination_summary: summary });
});

// GET /api/v1/campaigns/:id/destinations
export const listDestinations = asyncHandler(async (req, res) => {
  const status = req.query.status || null;
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(500, Number(req.query.limit) || 100);
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT d.*
     FROM ens_campaign_destinations d
     WHERE campaign_id = $1
       AND ($2::text IS NULL OR d.status = $2)
     ORDER BY d.id ASC
     LIMIT $3 OFFSET $4`,
    [req.params.id, status, limit, offset]
  );

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM ens_campaign_destinations
     WHERE campaign_id = $1 AND ($2::text IS NULL OR status = $2)`,
    [req.params.id, status]
  );

  res.json({ destinations: rows, total: cnt[0].total, page, limit });
});

// POST /api/v1/campaigns  — trigger a campaign from UI/API
export const triggerCampaign = asyncHandler(async (req, res) => {
  const d = TriggerSchema.parse(req.body);
  const campaign = await createCampaignByConfigId({
    configId:       d.ens_configuration_id,
    triggeredBy:    req.user?.id,
    triggeredVia:   'UI',
    messageAudioUrl: d.message_audio_url || null,
    messageText:    d.message_text || null,
  });
  res.status(201).json(campaign);
});

// POST /api/v1/campaigns/:id/pause
export const pause = asyncHandler(async (req, res) => {
  res.json(await pauseCampaign(req.params.id));
});

// POST /api/v1/campaigns/:id/resume
export const resume = asyncHandler(async (req, res) => {
  res.json(await resumeCampaign(req.params.id));
});

// POST /api/v1/campaigns/:id/cancel
export const cancel = asyncHandler(async (req, res) => {
  res.json(await cancelCampaign(req.params.id));
});

// GET /api/v1/campaigns/engine/stats
export const engineStats = asyncHandler(async (req, res) => {
  res.json(getEngineStats());
});
