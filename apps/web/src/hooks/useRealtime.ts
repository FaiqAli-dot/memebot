import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../lib/api';
import type { WsMessage } from '@memebot/shared';

export function useRealtime(onMessage?: (msg: WsMessage) => void): {
  connected: boolean;
  lastMessage: WsMessage | null;
  tick: number;
} {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const [tick, setTick] = useState(0);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 500;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        setConnected(true);
        retry = 500;
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          setTimeout(connect, retry);
          retry = Math.min(retry * 2, 8000);
        }
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsMessage;
          setLastMessage(msg);
          setTick((t) => t + 1);
          handler.current?.(msg);
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  return { connected, lastMessage, tick };
}
