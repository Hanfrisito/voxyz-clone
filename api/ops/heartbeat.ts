import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

const sb = createClient(supabaseUrl, supabaseKey);

const STALE_THRESHOLD_MS = 30 * 60 * 1000;

async function evaluateTriggers() {
  const { data: rules } = await sb
    .from('ops_trigger_rules')
    .select('*')
    .eq('enabled', true);

  if (!rules || rules.length === 0) return { fired: 0 };

  let firedCount = 0;
  for (const rule of rules) {
    const conditionMet = await checkCondition(rule);
    if (conditionMet) {
      await createProposalFromRule(rule);
      firedCount++;
    }
  }
  return { fired: firedCount };
}

async function checkCondition(rule: any): Promise<boolean> {
  return Math.random() > 0.7;
}

async function createProposalFromRule(rule: any) {
  await sb.from('ops_agent_events').insert({
    agent_id: rule.target,
    event_type: 'proposal_created',
    payload: {
      source: 'trigger',
      rule_id: rule.id,
      step_kind: rule.type,
      description: `Triggered by ${rule.source}`
    },
    created_at: new Date().toISOString()
  });
}

async function processReactionQueue() {
  const { data: reactions } = await sb
    .from('ops_agent_reactions')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(10);

  if (!reactions || reactions.length === 0) return { processed: 0 };

  for (const reaction of reactions) {
    await sb.from('ops_agent_reactions')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', reaction.id);
  }
  return { processed: reactions.length };
}

async function promoteInsights() {
  return { promoted: 0 };
}

async function recoverStaleSteps() {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: stale } = await sb
    .from('ops_mission_steps')
    .select('id, mission_id')
    .eq('status', 'running')
    .lt('updated_at', staleThreshold);

  if (!stale || stale.length === 0) return { recovered: 0 };

  for (const step of stale) {
    await sb.from('ops_mission_steps')
      .update({
        status: 'failed',
        last_error: 'Stale: no progress for 30 minutes',
        updated_at: new Date().toISOString()
      })
      .eq('id', step.id);

    await maybeFinalizeMissionIfDone(step.mission_id);
  }
  return { recovered: stale.length };
}

async function maybeFinalizeMissionIfDone(missionId: string) {
  const { data: steps } = await sb
    .from('ops_mission_steps')
    .select('status')
    .eq('mission_id', missionId);

  if (!steps || steps.length === 0) return;

  const allCompleted = steps.every(s => s.status === 'succeeded');
  const anyFailed = steps.some(s => s.status === 'failed');

  const newStatus = allCompleted ? 'succeeded' : anyFailed ? 'failed' : null;

  if (newStatus) {
    await sb.from('ops_missions')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', missionId);
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  try {
    const triggersResult = await evaluateTriggers();
    const reactionsResult = await processReactionQueue();
    const insightsResult = await promoteInsights();
    const staleResult = await recoverStaleSteps();

    return res.status(200).json({
      ok: true,
      triggers: triggersResult,
      reactions: reactionsResult,
      insights: insightsResult,
      stale: staleResult,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Heartbeat error:', error);
    return res.status(500).json({ error: error.message });
  }
}
