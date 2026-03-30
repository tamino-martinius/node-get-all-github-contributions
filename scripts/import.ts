import * as fs from "node:fs";
import * as path from "node:path";
import type { ImportConfig, ImportData } from "@/types/import";
import { GetAllGitHubContributions } from "../src/GetAllGitHubContributions";

const SAVE_INTERVAL = 30_000;

// --- Paths (resolved from project root, where npm run executes) ---
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const DATA_PATH = path.resolve(process.cwd(), "data/data.json");

// --- Load config & data ---
const config: ImportConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// Must always pass an object so we share the reference with Import and can observe progress
const data: ImportData = fs.existsSync(DATA_PATH)
  ? JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"))
  : { accounts: {}, languageColors: {}, importState: { accountProgress: {} } };

// --- Data persistence ---
function saveData() {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}
const saveInterval = setInterval(saveData, SAVE_INTERVAL);

// --- Run import ---
const getAllGitHubContributions = new GetAllGitHubContributions({
  config,
  data,
});
getAllGitHubContributions
  .sync()
  .then(() => {
    clearInterval(saveInterval);
    saveData();
  })
  .catch((err) => {
    console.error(err);
    saveData();
  });
