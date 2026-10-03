import type { WsEventType, WsMessage } from '@memebot/shared';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { logger } from '../utils/logger.js';

type Handler = (msg: WsMessage) => void;

const localHandlers = new Set<Handler>();
let wss: WebSocketServer | null = null;

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
  logger.info('WebSocket server attached at /ws');
  return wss;
}

export function publish<T>(type: WsEventType, payload: T): void {
  const message: WsMessage<T> = {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  const raw = JSON.stringify(message);
  if (wss) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }
  for (const h of localHandlers) h(message as WsMessage);
}

export function subscribe(handler: Handler): () => void {
  localHandlers.add(handler);
  return () => localHandlers.delete(handler);
}
