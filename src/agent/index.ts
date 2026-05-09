import { startLocalReader } from "./local-reader.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

startLocalReader().catch((error) => {
  console.error(error);
  waitBeforeExit().finally(() => process.exit(1));
});

async function waitBeforeExit() {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input, output });
  await rl.question("程序启动失败。按回车键退出...");
  rl.close();
}
