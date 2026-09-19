import {
  BotAddSchema,
  C2S,
  HostAttachSchema,
  HostConfigSchema,
  RiggedStartSchema,
  RoomCreateSchema,
  RoomJoinSchema,
  SeatKickSchema,
  SignedSchema,
  TurnAimSchema,
  WalletBindSchema,
  type Ack,
} from "@blankcheck/shared";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { jevEnabled, jevStats } from "./ai/jev";
import { config } from "./config";
import { createReferee } from "./referee";
import type { Referee } from "./referee/Referee";
import type { Bank } from "./bank/Bank";
import { MockBank } from "./bank/MockBank";
import { newRoomCode, Room } from "./rooms";

type SocketData = { role?: "tv" | "phone"; room?: string; playerId?: string };

const Empty = z.object({}).passthrough();

/** Validate a payload, run the handler, and always answer the ack. */
function on<S extends z.ZodType, R extends object>(
  socket: Socket,
  event: string,
  schema: S,
  handler: (data: z.infer<S>) => Promise<Ack<R> | string | void> | Ack<R> | string | void,
) {
  socket.on(event, async (raw: unknown, ack?: (a: Ack<R>) => void) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) return reply({ ok: false, error: parsed.error.issues[0]?.message ?? "Bad request" });
    try {
      const out = await handler(parsed.data);
      if (typeof out === "string") reply({ ok: false, error: out });
      else reply((out as Ack<R>) ?? ({ ok: true } as Ack<R>));
    } catch (e) {
      console.error(`[${event}]`, e);
      reply({ ok: false, error: "Server error" });
    }
  });
}

export function createGameServer(opts: { makeReferee?: () => Referee; bank?: Bank } = {}) {
  const makeReferee = opts.makeReferee ?? createReferee;
  // One bank for the whole server: a phone keeps its wallet from game to game.
  const bank = opts.bank ?? new MockBank();
  const rooms = new Map<string, Room>();

  const http = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.url === "/health" || req.url === "/") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          name: "blank-check",
          rooms: rooms.size,
          refereeMode: config.refereeMode,
          bankMode: bank.mode,
          waitForChain: config.waitForChain,
          jev: jevEnabled() ? { ...jevStats } : false,
          demo: !!config.demoSeed,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const io = new Server(http, {
    cors: { origin: config.corsOrigins.includes("*") ? true : config.corsOrigins, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;
    const room = () => (data.room ? rooms.get(data.room) : undefined);
    const tvRoom = () => (data.role === "tv" ? room() : undefined);
    const mySeat = () => {
      const r = room();
      if (!r || data.role !== "phone" || !data.playerId) return undefined;
      const seat = r.state.seats.find((x) => x.playerId === data.playerId);
      return seat ? { r, seat: seat.seat } : undefined;
    };

    /* ───── TV ───── */

    on(socket, C2S.roomCreate, RoomCreateSchema, (d) => {
      const code = newRoomCode((c) => rooms.has(c));
      const r = new Room(code, io, makeReferee, bank, d.rounds, d.faceIdOnTrigger);
      rooms.set(code, r);
      Object.assign(data, { role: "tv", room: code });
      socket.join(r.all);
      r.snapshotFor((ev, p) => socket.emit(ev, p));
      console.log(`[room ${code}] created (referee ${r.refereeMode}, bank ${bank.mode})`);
      return { ok: true, room: code, hostToken: r.hostToken };
    });

    on(socket, C2S.hostAttach, HostAttachSchema, (d) => {
      const r = rooms.get(d.room);
      if (!r) return "That room is gone. Start a new one.";
      if (r.hostToken !== d.hostToken) return "Not the host of this room";
      Object.assign(data, { role: "tv", room: d.room });
      socket.join(r.all);
      r.snapshotFor((ev, p) => socket.emit(ev, p));
      return { ok: true };
    });

    on(socket, C2S.hostConfig, HostConfigSchema, (d) => tvRoom()?.setConfig(d) ?? (tvRoom() ? undefined : "Not the host"));
    on(socket, C2S.botAdd, BotAddSchema, (d) => (tvRoom() ? tvRoom()!.addBot(d.personality) : "Not the host"));
    on(socket, C2S.seatKick, SeatKickSchema, (d) => (tvRoom() ? tvRoom()!.kick(d.seat) : "Not the host"));
    on(socket, C2S.gameStart, Empty, async () => {
      const r = tvRoom();
      return r ? r.start() : "Not the host";
    });
    on(socket, C2S.gameRestart, Empty, () => {
      const r = tvRoom();
      if (!r) return "Not the host";
      r.restart();
    });

    /* ───── Phones ───── */

    on(socket, C2S.roomJoin, RoomJoinSchema, (d) => {
      const r = rooms.get(d.room);
      if (!r) return "No room with that code";
      socket.join(r.all);
      socket.join(r.playerRoom(d.playerId));
      const res = r.join(d.playerId, d.name, d.passkey ?? false);
      if ("error" in res) {
        socket.leave(r.all);
        socket.leave(r.playerRoom(d.playerId));
        return res.error;
      }
      Object.assign(data, { role: "phone", room: d.room, playerId: d.playerId });
      r.broadcast();
      return { ok: true, seat: res.seat };
    });

    on(socket, C2S.walletBind, WalletBindSchema, async (d) => {
      const me = mySeat();
      if (!me) return "Join a room first";
      const res = await me.r.bindWallet(me.seat, d.credentialId, d.publicKey);
      return "error" in res ? res.error : { ok: true, wallet: res.wallet };
    });

    on(socket, C2S.turnAim, TurnAimSchema, async (d) => {
      const me = mySeat();
      return me ? me.r.aim(me.seat, d.target) : "Join a room first";
    });

    on(socket, C2S.turnSigned, SignedSchema, (d) => {
      const me = mySeat();
      return me ? me.r.signedTrigger(me.seat, d.challengeId, d.assertion) : "Join a room first";
    });

    on(socket, C2S.cheatPlay, Empty, () => {
      const me = mySeat();
      return me ? me.r.cheat(me.seat) : "Join a room first";
    });

    on(socket, C2S.riggedStart, RiggedStartSchema, async (d) => {
      const me = mySeat();
      return me ? me.r.riggedStart(me.seat, d.accused) : "Join a room first";
    });

    on(socket, C2S.riggedSigned, SignedSchema, (d) => {
      const me = mySeat();
      return me ? me.r.signedRigged(me.seat, d.challengeId, d.assertion) : "Join a room first";
    });

    on(socket, C2S.buyInStart, Empty, async () => {
      const me = mySeat();
      return me ? me.r.buyInStart(me.seat) : "Join a room first";
    });

    on(socket, C2S.buyInSigned, SignedSchema, async (d) => {
      const me = mySeat();
      return me ? me.r.buyInSigned(me.seat, d.challengeId, d.assertion) : "Join a room first";
    });

    on(socket, C2S.riggedCancel, Empty, () => {
      const me = mySeat();
      me?.r.cancelRigged(me.seat);
    });

    on(socket, C2S.boo, Empty, () => {
      const me = mySeat();
      me?.r.boo(me.seat);
    });

    socket.on("disconnect", () => {
      const r = room();
      if (r && data.role === "phone" && data.playerId) {
        const id = data.playerId;
        // Only mark offline if no other socket for this player is still connected (e.g. a quick refresh).
        setTimeout(() => {
          if (!io.sockets.adapter.rooms.get(r.playerRoom(id))?.size) r.setConnected(id, false);
        }, 1500);
      }
    });
  });

  // Rooms idle for 3 hours are cleaned up.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const [code, r] of rooms) {
      if (r.lastActivity < cutoff) {
        r.dispose();
        rooms.delete(code);
        console.log(`[room ${code}] closed (idle)`);
      }
    }
  }, 10 * 60 * 1000);
  sweep.unref();

  return {
    http,
    io,
    rooms,
    close() {
      clearInterval(sweep);
      for (const r of rooms.values()) r.dispose();
      io.close();
    },
  };
}
