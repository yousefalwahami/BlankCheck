import { jevEnabled } from "./ai/jev";
import { config } from "./config";
import { initBank } from "./bank";
import { initReferee } from "./referee";
import { createGameServer } from "./server";

const makeReferee = await initReferee();
const bank = await initBank();
const { http } = createGameServer({ makeReferee, bank });

http.listen(config.port, () => {
  console.log(`🃏 GAMBIT RODEO game server on :${config.port}`);
  console.log(`   bank: ${bank.mode} (${bank.ticker}) · referee: ${makeReferee().mode}${config.refereeMode === "thru" ? ` (${config.thruRpcUrl})` : ""} · wait for chain: ${config.waitForChain}`);
  console.log(`   jev: ${jevEnabled() ? "on" : "off (heuristic bots)"}${config.demoSeed ? ` · demo seed "${config.demoSeed}"` : ""}`);
  if (config.timeScale !== 1) console.log(`   time scale: ${config.timeScale}`);
});
