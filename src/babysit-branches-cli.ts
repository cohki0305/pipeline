import { main } from "./main";

process.exit(await main(["branch", ...process.argv.slice(2)]));
