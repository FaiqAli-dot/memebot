/**
 * Paper-only alerts via Telegram / Discord / email (disabled if unset).
 */
import { env } from '../config/env.js';
import { query } from '../db/client.js';
import { logger } from '../utils/logger.js';

export async function sendAlert(opts: {
  channel?: 'telegram' | 'discord' | 'email' | 'dashboard';
  severity: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  cooldownKey: string;
}): Promise<boolean> {
  const cooldownMs = env.ALERT_COOLDOWN_MS;
  const { rows } = await query<{ created_at: Date }>(
    `SELECT created_at FROM alert_log
     WHERE cooldown_key = $1 AND created_at > NOW() - ($2::text || ' milliseconds')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [opts.cooldownKey, String(cooldownMs)],
  );
  if (rows.length) return false;

  const channels: Array<'telegram' | 'discord' | 'email' | 'dashboard'> = opts.channel
    ? [opts.channel]
    : ['dashboard'];

  if (!opts.channel) {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push('telegram');
    if (env.DISCORD_WEBHOOK_URL) channels.push('discord');
    if (env.ALERT_EMAIL_TO) channels.push('email');
  }

  for (const channel of [...new Set(channels)]) {
    try {
      if (channel === 'telegram' && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: `[MemeBot PAPER] ${opts.title}\n${opts.body}`,
            }),
            signal: AbortSignal.timeout(5_000),
          },
        );
      } else if (channel === 'discord' && env.DISCORD_WEBHOOK_URL) {
        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: `**[MemeBot PAPER] ${opts.title}**\n${opts.body}`,
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } else if (channel === 'email') {
        // No SMTP in MVP — log only when configured
        logger.info({ to: env.ALERT_EMAIL_TO, title: opts.title }, 'Email alert (log-only)');
      }
      await query(
        `INSERT INTO alert_log (channel, severity, title, body, cooldown_key)
         VALUES ($1,$2,$3,$4,$5)`,
        [channel, opts.severity, opts.title, opts.body, opts.cooldownKey],
      );
    } catch (err) {
      logger.warn({ err, channel }, 'Alert send failed');
    }
  }
  return true;
}
