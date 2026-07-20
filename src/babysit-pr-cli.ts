import { main } from "./main";

process.exit(await main(["babysit-pr", ...process.argv.slice(2)]));
