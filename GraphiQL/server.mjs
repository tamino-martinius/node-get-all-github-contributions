import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "../../../../../..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const token = config.accounts[0].tokens[0];

const html = readFileSync(join(__dirname, "index.html"), "utf-8").replace(
	"__GITHUB_TOKEN__",
	token,
);

createServer((_req, res) => {
	res.writeHead(200, { "Content-Type": "text/html" });
	res.end(html);
}).listen(4000, () => {
	console.log("GraphiQL running at http://localhost:4000");
});
