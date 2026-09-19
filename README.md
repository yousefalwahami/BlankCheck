# BLANK CHECK

> **Everyone cheats. The chain remembers.**

A Jackbox-style party game. The laptop plays on the TV, phones are controllers, Face ID pulls the trigger,
and a referee program written in C on the Thru blockchain keeps sealed evidence of every cheat.

The full build spec lives in [docs/BLANK_CHECK_SPEC.md](docs/BLANK_CHECK_SPEC.md).

## Layout

```
apps/web          Next.js: TV (/host) and phone controller (/join, /play/[room])
apps/server       Node + Socket.IO game server, game engine, referee clients, bots
packages/shared   Shared types, zod schemas, hashing (must match the C program byte for byte)
programs/referee  The C referee program for the Thru VM
```
