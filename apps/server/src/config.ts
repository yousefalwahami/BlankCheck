const env = process.env;

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: Number(env.PORT ?? 4000),
  /** Comma-separated; "*" (or unset) allows any origin, which is fine for a party game with no auth. */
  corsOrigins: (env.CORS_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  refereeMode: (env.REFEREE_MODE === "thru" ? "thru" : "mock") as "mock" | "thru",
  waitForChain: bool(env.WAIT_FOR_CHAIN, true),
  /** Even when waiting for the chain, never hold the table longer than this for one confirmation. */
  chainWaitCapMs: Number(env.CHAIN_WAIT_CAP_MS ?? 4000),
  thruRpcUrl: env.THRU_RPC_URL ?? "https://rpc.alphanet.thru.org",
  explorerUrl: (env.EXPLORER_URL ?? "https://scan.thru.org").replace(/\/$/, ""),
  thruHostSecret: env.THRU_HOST_SECRET ?? "",
  refereeProgramAddress: env.REFEREE_PROGRAM_ADDRESS ?? "",
  passkeyManagerProgramAddress: env.PASSKEY_MANAGER_PROGRAM_ADDRESS ?? "",
  /** Optional per-tx resource requests (SDK defaults otherwise). CREATE_TABLE allocates ~75 KB. */
  txComputeUnits: env.THRU_COMPUTE_UNITS ? Number(env.THRU_COMPUTE_UNITS) : undefined,
  txStateUnits: env.THRU_STATE_UNITS ? Number(env.THRU_STATE_UNITS) : undefined,
  txMemoryUnits: env.THRU_MEMORY_UNITS ? Number(env.THRU_MEMORY_UNITS) : undefined,
  typesafeApiKey: env.TYPESAFE_API_KEY ?? "",
  jevModel: env.JEV_MODEL ?? "",
  demoSeed: env.DEMO_SEED ?? "",
  /** Multiplies every game timer (tests use 0.02 to play a whole game in seconds). */
  timeScale: Math.max(0, Number(env.TIME_SCALE ?? 1)) || 1,
};
