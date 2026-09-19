"use client";

import type { Ack } from "@blankcheck/shared";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { resolveServerUrl } from "./serverUrl";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(resolveServerUrl(), {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
  }
  return socket;
}

export function emitAck<T extends object = {}>(event: string, payload: unknown = {}, timeoutMs = 10_000): Promise<Ack<T>> {
  const s = getSocket();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: "The server didn't answer. Check your connection." }), timeoutMs);
    s.emit(event, payload, (a: Ack<T>) => {
      clearTimeout(t);
      resolve(a);
    });
  });
}

export function useConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    setConnected(s.connected);
    s.on("connect", on);
    s.on("disconnect", off);
    return () => {
      s.off("connect", on);
      s.off("disconnect", off);
    };
  }, []);
  return connected;
}

/** Subscribe to a server event for the lifetime of a component. */
export function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  useEffect(() => {
    const s = getSocket();
    s.on(event, handler);
    return () => {
      s.off(event, handler);
    };
  }, [event, handler]);
}
