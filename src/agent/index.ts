import { startLocalReader } from "./local-reader.js";

startLocalReader().catch((error) => {
  console.error(error);
  process.exit(1);
});
