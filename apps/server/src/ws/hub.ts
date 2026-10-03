import type { WsEventType, WsMessage } from '@memebot/shared';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import pg from 'pg';
import { env } from '../config/env.js';
import { query } from '../db/client.js';
import { logger } from '../utils/logger.js';

type Handler = (msg: WsMessage) => void;

const CHANNEL = 'memebot_events';
// Postgres rejects NOTIFY payloads of 8000 bytes or more.
const MAX_NOTIFY_BYTES = 7900;

const localHandlers = new Set<Handler>();
let wss: WebSocketServer | null = null;
let listener: pg.Client | null = null;
let listenerStopped = false;
let reconnectDelay = 500;

function broadcast(raw: string): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

async function startListener(): Promise<void> {
  if (listenerStopped) return;
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  const retry = () => {
    if (listener === client) listener = null;
    client.removeAllListeners();
    void client.end().catch(() => undefined);
    if (listenerStopped) return;
    setTimeout(() => void startListener(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };
  client.on('error', (err) => {
    logger.warn({ err }, 'Event listener connection error — reconnecting');
    retry();
  });
  client.on('notification', (n) => {
    if (n.channel === CHANNEL && n.payload) broadcast(n.payload);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
    reconnectDelay = 500;
    logger.info({ channel: CHANNEL }, 'Listening for worker events');
  } catch (err) {
    logger.warn({ err }, 'Event listener failed to connect — retrying');
    retry();
  }
}

export function attachWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'bot_status',
        payload: { connected: true },
        timestamp: new Date().toISOString(),
      }),
    );
    socket.on('error', (err) => logger.warn({ err }, 'WS client error'));
  });
  listenerStopped = false;
  void startListener();
  logger.info('WebSocket server attached at /ws');
  return wss;
}

export async function closeWebSocket(): Promise<void> {
  listenerStopped = true;
  const client = listener;
  listener = null;
  if (client) await client.end().catch(() => undefined);
  wss?.close();
  wss = null;
}

export function publish<T>(type: WsEventType, payload: T): void {
  const message: WsMessage<T> = {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  let raw = JSON.stringify(message);
  if (Buffer.byteLength(raw) > MAX_NOTIFY_BYTES) {
    raw = JSON.stringify({ ...message, payload: null });
  }
  query('SELECT pg_notify($1, $2)', [CHANNEL, raw]).catch((err) =>
    logger.warn({ err, type }, 'Failed to publish event'),
  );
  for (const h of localHandlers) h(message as WsMessage);
}

export function subscribe(handler: Handler): () => void {
  localHandlers.add(handler);
  return () => localHandlers.delete(handler);
}
