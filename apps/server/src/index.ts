import { jevEnabled } from "./ai/jev";
import { config } from "./config";
import { createGameServer } from "./server";

const { http } = createGameServer();

http.listen(config.port, () => {
  console.log(`🃏 BLANK CHECK game server on :${config.port}`);
  console.log(`   referee: ${config.refereeMode}${config.refereeMode === "thru" ? ` (${config.thruRpcUrl})` : ""} · wait for chain: ${config.waitForChain}`);
  console.log(`   jev: ${jevEnabled() ? "on" : "off (heuristic bots)"}${config.demoSeed ? ` · demo seed "${config.demoSeed}"` : ""}`);
  if (config.timeScale !== 1) console.log(`   time scale: ${config.timeScale}`);
});
