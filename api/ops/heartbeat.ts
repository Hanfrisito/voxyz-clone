import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

const STALE_THRESHOLD_MS = 30 * 60 * 1000;

// ==================== PROPOSAL SERVICE ====================

async function createProposal(source: string, step_kind: string, description: string, payload?: any) {
  // 1. Cap Gates
  const gateResult = await checkCapGate(step_kind);
  if (!gateResult.ok) {
    // Rechazar propuesta
    const { data: proposal } = await sb
      .from('ops_mission_proposals')
      .insert({
        source,
        step_kind,
        description,
        status: 'rejected',
        reason: gateResult.reason
      })
      .select()
      .single();
    return { proposal, approved: false };
  }

  // 2. Insert proposal (approved immediately)
  const { data: proposal } = await sb
    .from('ops_mission_proposals')
    .insert({
      source,
      step_kind,
      description,
      status: 'approved'
    })
    .select()
    .single();

  // 3. Auto-approve check (enabled by default for all kinds)
  const autoApprove = await checkAutoApprove(step_kind);
  if (autoApprove) {
    // Crear misión y step
    const { data: mission } = await sb
      .from('ops_missions')
      .insert({ proposal_id: proposal.id, status: 'approved' })
      .select()
      .single();

    await sb.from('ops_mission_steps').insert({
      mission_id: mission.id,
      step_kind,
      status: 'queued',
      payload: payload || {}
    });

    return { proposal, mission, approved: true };
  }

  return { proposal, approved: false };
}

async function checkCapGate(step_kind: string) {
  const gates: Record<string, (sb: any) => Promise<{ ok: boolean; reason?: string }>> = {
    write_content: checkWriteContentGate,
    post_tweet: checkPostTweetGate,
    deploy: checkDeployGate,
    generate_website: checkGenerateWebsiteGate,
    audit_site: checkAuditSiteGate,
    deploy_site: checkDeploySiteGate,
    send_client_email: checkSendEmailGate
  };

  const gate = gates[step_kind];
  if (!gate) return { ok: true };
  return await gate(sb);
}

async function checkWriteContentGate(sb: any) {
  const policy = await getPolicy('x_daily_content_limit');
  const limit = Number(policy?.limit ?? 10);
  const { count } = await sb
    .from('ops_mission_steps')
    .select('id', { count: 'exact', head: true })
    .eq('step_kind', 'write_content')
    .eq('status', 'succeeded')
    .gte('completed_at', startOfTodayUtcIso());

  if ((count ?? 0) >= limit) {
    return { ok: false, reason: `Daily content limit reached (${count}/${limit})` };
  }
  return { ok: true };
}

async function checkPostTweetGate(sb: any) {
  const autopost = await getPolicy('x_autopost');
  if (autopost?.enabled === false) {
    return { ok: false, reason: 'x_autopost disabled' };
  }
  const quota = await getPolicy('x_daily_quota');
  const limit = Number(quota?.limit ?? 10);
  const { count } = await sb
    .from('ops_mission_steps')
    .select('id', { count: 'exact', head: true })
    .eq('step_kind', 'post_tweet')
    .eq('status', 'succeeded')
    .gte('completed_at', startOfTodayUtcIso());

  if ((count ?? 0) >= limit) {
    return { ok: false, reason: `Daily tweet quota reached (${count}/${limit})` };
  }
  return { ok: true };
}

async function checkDeployGate(sb: any) {
  const policy = await getPolicy('x_deploy_window');
  if (policy?.enabled === false) {
    return { ok: false, reason: 'x_deploy_window disabled' };
  }
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour < 8 || hour >= 20) {
    return { ok: false, reason: 'Deploy only allowed 8:00-20:00 UTC' };
  }
  return { ok: true };
}

async function checkGenerateWebsiteGate(sb: any) {
  const policy = await getPolicy('x_daily_gen_limit');
  const limit = Number(policy?.limit ?? 20);
  const { count } = await sb
    .from('ops_mission_steps')
    .select('id', { count: 'exact', head: true })
    .eq('step_kind', 'generate_website')
    .eq('status', 'succeeded')
    .gte('completed_at', startOfTodayUtcIso());

  if ((count ?? 0) >= limit) {
    return { ok: false, reason: `Daily generation limit reached (${count}/${limit})` };
  }
  return { ok: true };
}

async function checkAuditSiteGate(sb: any) {
  return { ok: true };
}

async function checkDeploySiteGate(sb: any) {
  return checkDeployGate(sb);
}

async function checkSendEmailGate(sb: any) {
  const policy = await getPolicy('x_daily_email_limit');
  const limit = Number(policy?.limit ?? 50);
  const { count } = await sb
    .from('ops_mission_steps')
    .select('id', { count: 'exact', head: true })
    .eq('step_kind', 'send_client_email')
    .eq('status', 'succeeded')
    .gte('completed_at', startOfTodayUtcIso());

  if ((count ?? 0) >= limit) {
    return { ok: false, reason: `Daily email limit reached (${count}/${limit})` };
  }
  return { ok: true };
}

async function checkAutoApprove(step_kind: string): Promise<boolean> {
  const policy = await getPolicy('auto_approve');
  if (!policy?.enabled) return false;
  const allowed = policy.allowed_step_kinds as string[] || [];
  if (policy.allowed_step_kinds === undefined || policy.allowed_step_kinds.length === 0) {
    return step_kind !== 'deploy_site' && step_kind !== 'deploy';
  }
  return allowed.includes(step_kind);
}

async function getPolicy(id: string) {
  const { data } = await sb.from('ops_policy').select('value').eq('id', id).single();
  return data?.value || null;
}

function startOfTodayUtcIso() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start).toISOString();
}

// ==================== HEARTBEAT ====================

async function evaluateTriggers() {
  const { data: rules } = await sb
    .from('ops_trigger_rules')
    .select('*')
    .eq('enabled', true);

  if (!rules || rules.length === 0) return { fired: 0 };

  let firedCount = 0;
  for (const rule of rules) {
    if (await checkCondition(rule)) {
      await createProposal('trigger', rule.type, `Trigger: ${rule.name}`, {
        rule_id: rule.id,
        source: rule.source,
        target: rule.target,
        probability: rule.probability
      });
      firedCount++;
    }
  }
  return { fired: firedCount };
}

async function checkCondition(rule: any): Promise<boolean> {
  if (rule.probability !== undefined) {
    return Math.random() < rule.probability;
  }
  return false;
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

// ==================== EXPORT ====================

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
