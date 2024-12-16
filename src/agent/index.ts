import { ai } from "@/core/ai";
import { log } from "@/core/utils/logger";
import dotenv from "dotenv";
import fs from "fs/promises";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { duckyCharacter } from "./ai/character/ducky";
import { config } from "./ai/config";
// Get equivalent of __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();

const args = process.argv.slice(2);
const port = args[0] ? parseInt(args[0]) : 8001;

async function loadTwitterCookies() {
  try {
    if (process.env.TWITTER_COOKIES) {
      try {
        return JSON.parse(process.env.TWITTER_COOKIES);
      } catch (error) {
        log.error(
          "Failed to parse TWITTER_COOKIES environment variable:",
          error
        );
        throw new Error(
          "TWITTER_COOKIES environment variable contains invalid JSON"
        );
      }
    }
    const cookiesPath = path.join(__dirname, "ai", "config", "cookies.json");
    const cookiesData = await fs.readFile(cookiesPath, "utf-8");
    return JSON.parse(cookiesData);
  } catch (error) {
    log.error("Failed to load Twitter cookies:", error);
    throw new Error("Twitter cookies file is required but couldn't be loaded");
  }
}

log.info(`Initializing Agent Ducky 00${port === 8001 ? 7 : 8}...`);
const instance = await ai.initialize({
  databaseUrl: process.env.DATABASE_URL!,
  fatduck: {
    baseUrl: process.env.FATDUCK_API_URL!,
    apiKey: process.env.FATDUCK_API_KEY!,
  },
  llmConfig: {
    apiKey: process.env.TOGETHER_API_KEY!,
    baseURL: process.env.TOGETHER_API_URL!,
    llm: {
      model: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      temperature: 0.7,
    },
    analyzer: {
      model: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      temperature: 0.3,
    },
    imageGeneration: {
      model: "black-forest-labs/FLUX.1.1-pro",
      moderationModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    },
  },
  character: duckyCharacter,
  refreshCharacterOnRestart: true,
  toolsDir: path.join(__dirname, "./ai/tools"),
  coingecko: {
    enabled: true,
    apiKey: process.env.COINGECKO_API_KEY!,
    updateInterval: "0 0 * * *",
    initialScan: {
      enabled: true,
      batchSize: 50, // Process 5 coins in parallel
      delay: 6000,
    },
  },
  scheduledPosts: {
    enabled: true,
    posts: [
      {
        type: "image",
        schedule: "0 */2 * * *", // Every 4 hours
        enabled: false,
      },
      {
        type: "market_update",
        schedule: "30 * * * *", // Every 30 minutes
        enabled: false,
      },
      {
        type: "movers_alpha",
        schedule: "10 */1 * * *", // Every 1 hour and 10 minutes
        enabled: false,
      },
      {
        type: "market_cap_movers",
        schedule: "20 */4 * * *", // Every 4 hours and 10 minutes
        enabled: true,
      },
    ],
    debug: true,
    runOnStartup: true,
  },
  platforms: {
    telegram: {
      enabled: false,
      token: process.env.TELEGRAM_BOT_TOKEN!,
    },
    api: {
      enabled: false,
      port: 3000,
      cors: {
        allowedOrigins: ["http://localhost"],
      },
    },
    twitter: {
      enabled: true,
      cookies: await loadTwitterCookies(),
      username: "duckunfiltered",
      debug: {
        checkMentionsOnStartup: false,
      },
      checkInterval: "*/2 * * * *", // Check every 2 minutes
      maxTweetsPerCheck: 30,
      rateLimit: {
        userMaxPerHour: 5,
        globalMaxPerHour: 30,
      },
    },
    p2p: {
      enabled: false,
      port, // You can change this port or read from env
      privateKey: process.env.PRIVATE_KEY!, // Add this to your .env file
      initialPeers:
        port === 8001
          ? [
              "/ip4/127.0.0.1/tcp/8002/p2p/12D3KooWQAvECRBqh8iArmzvBDksSWUVbHzPD5sy4hQ1eVZRecYM",
            ]
          : [
              "/ip4/127.0.0.1/tcp/8001/p2p/12D3KooWSWxvpnKXT8aNXKbxuGEmhQWHzo16PRKtTk3R2ga9vtns",
            ],
    },
  },
  quantum: {
    enabled: true,
    checkInitialState: false,
    cronSchedule: "0 */4 * * *", // 4 hours
    ibmConfig: {
      apiToken: process.env.IBM_QUANTUM_API_TOKEN!,
      backend: "ibm_brisbane",
      timeout: 30000,
    },
  },
  platformDefaults: {
    telegram: config.telegram,
    twitter: config.twitter,
  },
});
