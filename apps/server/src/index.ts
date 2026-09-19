import { jevEnabled } from "./ai/jev";
import { config } from "./config";
import { initReferee } from "./referee";
import { createGameServer } from "./server";

const makeReferee = await initReferee();
const { http } = createGameServer({ makeReferee });

http.listen(config.port, () => {
  console.log(`🃏 GAMBIT RODEO game server on :${config.port}`);
  console.log(`   referee: ${makeReferee().mode}${config.refereeMode === "thru" ? ` (${config.thruRpcUrl})` : ""} · wait for chain: ${config.waitForChain}`);
  console.log(`   jev: ${jevEnabled() ? "on" : "off (heuristic bots)"}${config.demoSeed ? ` · demo seed "${config.demoSeed}"` : ""}`);
  if (config.timeScale !== 1) console.log(`   time scale: ${config.timeScale}`);
});
