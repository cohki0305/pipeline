import { main } from "./main";

process.exit(await main(["babysit", ...process.argv.slice(2)]));
