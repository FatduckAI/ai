import cron from "node-cron";
import fetch from "node-fetch";
import { type ai } from "../ai";
import type { TwitterClient } from "../platform/twitter/api/src/client";
import { log } from "../utils/logger";

export interface ScheduledPostConfig {
  type: "image" | "market_update" | "movers_alpha" | "market_cap_movers";
  schedule: string;
  enabled: boolean;
  maxPerDay?: number;
}

interface TimelineTweet {
  id: string;
  text: string;
  authorUsername: string;
  createdAt: string;
}

interface TimelineContext {
  recentTweets: TimelineTweet[];
  tokenMetrics?: Record<string, any>;
}

export class ScheduledPostManager {
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private postCounts: Map<string, number> = new Map();
  private lastResetDate: Date = new Date();

  constructor(
    private ai: ai,
    private configs: ScheduledPostConfig[],
    private twitterClient?: TwitterClient,
    private debug?: boolean,
    private runOnStartup?: boolean,
    private lastCategory?: string
  ) {
    this.resetDailyCounts();
    log.info(
      "ScheduledPostManager initialized with Twitter client:",
      !!twitterClient
    );
  }

  async start() {
    // Debug mode - run once immediately
    if (this.runOnStartup) {
      log.info("Debug mode: Running immediate scheduled posts...");
      for (const config of this.configs) {
        if (config.enabled) {
          try {
            await this.handleScheduledPost(config);
          } catch (error) {
            log.error(`Error in debug scheduled post (${config.type}):`, error);
          }
        }
      }
      return;
    }

    // Normal cron mode
    for (const config of this.configs) {
      if (!config.enabled) continue;
      const job = cron.schedule(config.schedule, async () => {
        try {
          log.info(`Running scheduled post: ${config.type}`);
          await this.handleScheduledPost(config);
        } catch (error) {
          log.error(`Error in scheduled post (${config.type}):`, error);
        }
      });
      this.cronJobs.set(config.type, job);
      log.info(`Scheduled post manager started for type: ${config.type}`);
    }
  }

  async stop() {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
    log.info("Scheduled post manager stopped");
  }

  private async handleScheduledPost(config: ScheduledPostConfig) {
    log.info(`Handling scheduled post: ${config.type}`);
    const correlationId = `scheduled-${config.type}-${Date.now()}`;

    // Check daily limit
    if (this.checkDailyLimit(config)) {
      log.warn(`Daily limit reached for ${config.type}`);
      return;
    }

    try {
      switch (config.type) {
        case "image":
          await this.handleImagePost(correlationId);
          break;
        case "market_update":
          await this.handleMarketUpdatePost(correlationId);
          break;
        case "movers_alpha":
          await this.handleMovementPost(correlationId);
          break;
        case "market_cap_movers":
          await this.handleMarketCapMoversPost(correlationId);
          break;
        default:
          throw new Error(`Unsupported post type: ${config.type}`);
      }

      this.incrementPostCount(config.type);
    } catch (error) {
      log.error(`Failed to handle scheduled post (${config.type}):`, error);
      await this.ai.eventService.createInteractionEvent("interaction.failed", {
        input: config.type,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
        messageId: "",
        user: {
          id: "",
          metadata: { correlationId },
        },
      });
    }
  }

  private async analyzeTimeline(): Promise<TimelineContext | null> {
    if (!this.twitterClient) {
      return null;
    }

    try {
      // Fetch 0xglu's recent timeline
      const timeline = await this.twitterClient.getUserTimeline("0xglu", {
        excludeRetweets: false,
      });

      // Get token details
      let tokenMetrics = {};
      return {
        recentTweets: timeline.map((tweet) => ({
          id: tweet.id,
          text: tweet.text,
          authorUsername: tweet.authorUsername || "",
          createdAt: tweet.createdAt?.toISOString() || "",
        })),
        tokenMetrics,
      };
    } catch (error) {
      log.error("Error analyzing timeline:", error);
      return null;
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    // Fetch the image
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    // Get the image data as a buffer and return it directly
    return await response.buffer();
  }

  private async handleImagePost(correlationId: string) {
    try {
      // Get timeline context before generating content
      const timelineContext = await this.analyzeTimeline();

      // Generate image post content with timeline context
      const { imageUrl, tweetText } =
        await this.ai.llmManager.generateScheduledImagePost({
          timelineContext: timelineContext || undefined,
        });

      // Track content generation
      await this.ai.eventService.createInteractionEvent("interaction.started", {
        input: tweetText,
        responseType: "image",
        platform: "twitter",
        timestamp: new Date().toISOString(),
        messageId: "",
        replyTo: "",
        hasMention: false,
        imageGeneration: {
          url: imageUrl,
        },
        user: {
          id: "",
          metadata: { correlationId },
        },
      });

      // Post to Twitter
      if (this.debug) {
        log.info("Debug mode enabled, skipping Twitter post");
        log.info("Tweet text:", tweetText);
        log.info("Image URL:", imageUrl);
        return;
      }

      if (this.twitterClient) {
        const imageBuffer = await this.downloadImage(imageUrl);

        const tweet = await this.twitterClient.sendTweet(tweetText, {
          media: [
            {
              data: imageBuffer,
              type: "image/jpeg",
            },
          ],
        });

        await this.ai.eventService.createInteractionEvent(
          "interaction.completed",
          {
            input: tweetText,
            response: tweet.id,
            responseType: "image",
            platform: "twitter",
            processingTime: 0,
            timestamp: new Date().toISOString(),
            messageId: "",
            replyTo: "",
            imageGeneration: {
              url: imageUrl,
            },
            user: {
              id: "",
              metadata: { correlationId },
            },
          }
        );
      }
    } catch (error) {
      await this.ai.eventService.createInteractionEvent("interaction.failed", {
        input: "",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
        messageId: "",
        user: {
          id: "",
          metadata: { correlationId },
        },
      });
      throw error;
    }
  }

  private async handleMarketUpdatePost(correlationId: string) {
    try {
      // Get timeline context before generating content
      // messages

      // get market update from Fatduck backend
      const marketUpdate = await this.ai.fatduckManager.getMarketUpdate("1hr");
      if (marketUpdate.marketAnalysis.length === 0) {
        log.warn("No market update found");
        return;
      }
      // Generate image post content with timeline context
      const { tweetText } =
        await this.ai.llmManager.generateScheduledMarketUpdate({
          marketUpdateContext: marketUpdate,
        });

      // Track content generation
      await this.ai.eventService.createInteractionEvent("interaction.started", {
        input: tweetText,
        responseType: "image",
        platform: "twitter",
        timestamp: new Date().toISOString(),
        messageId: "",
        replyTo: "",
        hasMention: false,
        user: {
          id: "",
          metadata: { correlationId },
        },
      });

      // Post to Twitter
      if (this.debug) {
        log.info("Debug mode enabled, skipping Twitter post");
        log.info("Tweet text:", tweetText);
        return;
      }

      if (this.twitterClient) {
        const tweet = await this.twitterClient.sendTweet(tweetText);
        //const tweet = { id: "1234567890" };

        await this.ai.eventService.createInteractionEvent(
          "interaction.completed",
          {
            input: tweetText,
            response: tweet.id,
            responseType: "image",
            platform: "twitter",
            processingTime: 0,
            timestamp: new Date().toISOString(),
            messageId: "",
            replyTo: "",
            user: {
              id: "",
              metadata: { correlationId },
            },
          }
        );
      }
    } catch (error) {
      await this.ai.eventService.createInteractionEvent("interaction.failed", {
        input: "",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
        messageId: "",
        user: {
          id: "",
          metadata: { correlationId },
        },
      });
      throw error;
    }
  }

  private async handleMovementPost(correlationId: string) {
    try {
      // Get movement data for all tracked categories
      const categories = ["virtuals-protocol-ecosystem", "ai-meme-coins"];
      const movementData = await this.ai.fatduckManager.getCategoryMovements(
        categories
      );

      // Format movement update text
      let tweetText = `🚀 Significant last hour movers\n\n`;
      // Process each category's movements
      for (const categoryData of movementData.categories) {
        if (categoryData.movements.length > 0) {
          // Add category header with emoji based on category
          tweetText += `${categoryData.category.name}:\n`;

          // Add all movements (up to 3 per category)
          for (const movement of categoryData.movements.slice(0, 5)) {
            const changePrefix =
              movement.metrics.price.change1h >= 0 ? "+" : "";
            log.info(
              movement.metrics.price.current.toString(),
              movement.metrics.price.change1h
            );
            const change = movement.metrics.price.change1h.toFixed(1);
            const score = 0;

            tweetText += `$${movement.symbol} ${changePrefix}${change}% | ${
              movement.metadata?.twitterHandle
                ? `@${movement.metadata?.twitterHandle}`
                : ""
            }\n`;
          }
          tweetText += "\n";
        }
      }

      // Filter tokens to only include those with positive price movement and Twitter handles
      const tokensWithTwitter = movementData.categories.flatMap((category) =>
        category.movements.filter(
          (m) => m.metrics.price.change1h > 0 && m.metadata?.twitterHandle
        )
      );

      // Only proceed if we have positive performers to analyze
      if (tokensWithTwitter.length > 0) {
        // Fetch timelines only for positive performers
        const timelineResults = await Promise.allSettled(
          tokensWithTwitter.map(async (token) => ({
            symbol: token.symbol,
            priceChange: token.metrics.price.change1h,
            handle: token.metadata?.twitterHandle!,
            timeline: await this.twitterClient?.getUserTimeline(
              token.metadata?.twitterHandle!,
              {
                excludeRetweets: true,
                limit: 10,
              }
            ),
          }))
        );

        const timelineData = timelineResults
          .filter(
            (
              result
            ): result is PromiseFulfilledResult<{
              symbol: string;
              priceChange: number;
              handle: string;
              timeline: any;
            }> =>
              result.status === "fulfilled" &&
              result.value.timeline !== undefined
          )
          .map((result) => ({
            symbol: result.value.symbol,
            priceChange: result.value.priceChange,
            handle: result.value.handle,
            tweets:
              result.value.timeline?.map((tweet: any) => ({
                text: tweet.text,
                createdAt: tweet.createdAt?.toISOString() || "",
              })) || [],
          }));

        // Only proceed with analysis if we have any valid timelines
        if (timelineData.length > 0) {
          const analysis = await this.ai.llmManager.analyzeTokenTimelines(
            timelineData
          );

          tweetText += `My Analysis:\n`;
          if (analysis.selectedTokens.length > 0) {
            tweetText += `$${analysis.selectedTokens[0].symbol}: ${analysis.selectedTokens[0].analysis}\n\n`;
          }
        }
      }

      // Track content generation
      await this.ai.eventService.createInteractionEvent("interaction.started", {
        input: tweetText,
        responseType: "movement_update",
        platform: "twitter",
        timestamp: new Date().toISOString(),
        messageId: "",
        replyTo: "",
        hasMention: false,
        user: {
          id: "",
          metadata: { correlationId },
        },
      });

      // Post to Twitter
      if (this.debug) {
        log.info("Debug mode enabled, skipping Twitter post");
        log.info("Tweet text:", tweetText);
        return;
      }

      if (this.twitterClient) {
        const tweet = await this.twitterClient.sendTweet(tweetText);

        await this.ai.eventService.createInteractionEvent(
          "interaction.completed",
          {
            input: tweetText,
            response: tweet.id,
            responseType: "movement_update",
            platform: "twitter",
            processingTime: 0,
            timestamp: new Date().toISOString(),
            messageId: "",
            replyTo: "",
            user: {
              id: "",
              metadata: { correlationId },
            },
          }
        );
      }
    } catch (error) {
      await this.ai.eventService.createInteractionEvent("interaction.failed", {
        input: "",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
        messageId: "",
        user: {
          id: "",
          metadata: { correlationId },
        },
      });
      throw error;
    }
  }

  private async handleMarketCapMoversPost(correlationId: string) {
    try {
      // Determine which category to post based on the last posted category
      const useVirtuals =
        this.lastCategory === "ai-meme-coins" || this.lastCategory === null;
      const category = useVirtuals
        ? "virtuals-protocol-ecosystem"
        : "ai-meme-coins";

      let tweetText = "🔄 Top Market Cap\n\n";

      log.info(`Fetching data for category: ${category}`);
      const response = await this.ai.fatduckManager.getTopMarketCapMovers(
        category
      );

      const movements = response?.categories?.[0]?.movements;
      if (!movements?.length) {
        log.warn(`No movements found for category: ${category}`);
        return;
      }

      // Add category header
      tweetText += `${
        category === "ai-meme-coins" ? "AI Meme" : "Virtuals Protocol"
      }:\n`;

      // Sort by market cap
      const topMovers = movements
        .filter(
          (mover) =>
            mover.metrics?.marketCap?.current !== undefined &&
            mover.symbol !== '"　"'
        )
        .sort(
          (a, b) => b.metrics.marketCap.current - a.metrics.marketCap.current
        );

      for (const mover of topMovers) {
        const mcInMillions = mover.metrics.marketCap.current / 1000000;
        const mcFormatted =
          mcInMillions >= 1000
            ? `${(mcInMillions / 1000).toFixed(2)}B`
            : `${Math.round(mcInMillions)}M`;

        tweetText += `$${mover.symbol} ${mcFormatted}`;
        if (
          mover.metadata?.twitterHandle &&
          mover.metadata.twitterHandle !== "n/a"
        ) {
          tweetText += ` | @${mover.metadata.twitterHandle}`;
        }
        tweetText += "\n";
      }

      // Track content generation
      await this.ai.eventService.createInteractionEvent("interaction.started", {
        input: tweetText,
        responseType: "market_cap_update",
        platform: "twitter",
        timestamp: new Date().toISOString(),
        messageId: "",
        replyTo: "",
        hasMention: false,
        user: {
          id: "",
          metadata: { correlationId },
        },
      });

      // Post to Twitter
      if (this.debug) {
        log.info("Debug mode enabled, skipping Twitter post");
        log.info("Tweet text:", tweetText);
        return;
      }

      if (this.twitterClient) {
        const tweet = await this.twitterClient.sendTweet(tweetText);

        // Update the last posted category
        this.lastCategory = category;

        await this.ai.eventService.createInteractionEvent(
          "interaction.completed",
          {
            input: tweetText,
            response: tweet.id,
            responseType: "market_cap_update",
            platform: "twitter",
            processingTime: 0,
            timestamp: new Date().toISOString(),
            messageId: "",
            replyTo: "",
            user: {
              id: "",
              metadata: { correlationId },
            },
          }
        );
      }
    } catch (error) {
      log.error("Error in handleMarketCapMoversPost:", error);
      await this.ai.eventService.createInteractionEvent("interaction.failed", {
        input: "",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
        messageId: "",
        user: {
          id: "",
          metadata: { correlationId },
        },
      });
      throw error;
    }
  }

  private checkDailyLimit(config: ScheduledPostConfig): boolean {
    if (!config.maxPerDay) return false;
    const currentCount = this.postCounts.get(config.type) || 0;
    return currentCount >= config.maxPerDay;
  }

  private incrementPostCount(type: string) {
    const currentCount = this.postCounts.get(type) || 0;
    this.postCounts.set(type, currentCount + 1);
  }

  private resetDailyCounts() {
    // Reset counts daily
    setInterval(() => {
      const now = new Date();
      if (now.getDate() !== this.lastResetDate.getDate()) {
        this.postCounts.clear();
        this.lastResetDate = now;
      }
    }, 60 * 60 * 1000); // Check hourly
  }
}
