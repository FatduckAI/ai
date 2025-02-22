import type { ai } from "@/core/ai";
import { ImageManager } from "@/core/managers/image";
import type { InteractionDefaults } from "@/types";
import { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { ImageHandler } from "./handlers/imageHandler";
import { MessageHandler } from "./handlers/messageHandler";

export class TelegramClient {
  private bot: Telegraf;
  private messageHandler: MessageHandler;
  private readonly MAX_MESSAGE_LENGTH = 4096;
  private readonly PROCESSING_TIMEOUT = 30000;
  private processingMessages: Map<number, number> = new Map();
  private isRunning: boolean = false;
  private imageHandler: ImageHandler;

  constructor(
    token: string,
    private ai: ai,
    private defaults?: InteractionDefaults
  ) {
    this.bot = new Telegraf(token);
    this.messageHandler = new MessageHandler(ai, defaults);
    const imageManager = new ImageManager(ai.llmManager, ai.eventService);
    this.imageHandler = new ImageHandler(imageManager, ai);
    this.setupMiddleware();
    this.setupHandlers();
  }

  public async start() {
    try {
      this.bot
        .launch()
        .then(() => {
          this.isRunning = true;
          console.log("Telegram bot started successfully!");
        })
        .catch((error) => {
          console.error("Failed to start Telegram bot:", error);
          this.isRunning = false;
        });

      process.once("SIGINT", () => this.stop());
      process.once("SIGTERM", () => this.stop());
    } catch (error) {
      console.error("Failed to initialize Telegram bot:", error);
      throw error;
    }
  }

  public async stop() {
    if (this.isRunning) {
      await this.bot.stop("SIGTERM");
      this.isRunning = false;
      console.log("Telegram bot stopped successfully");
    }
  }

  private setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      try {
        const chatId = ctx.chat?.id.toString();
        if (!chatId) return;

        if (!chatId.startsWith("-")) {
          return;
        }

        const adminChatId = this.ai.character.identity?.telegram_admin_chat;
        if (!adminChatId) {
          console.error("No admin chat configured");
          return;
        }

        if (chatId === adminChatId) {
          return next();
        }

        try {
          await ctx.leaveChat();
        } catch (error) {
          console.error("Failed to leave chat:", error);
        }
      } catch (error) {
        console.error("Middleware error:", error);
      }
    });
  }

  private setupHandlers() {
    this.registerCommands();

    this.bot.on(message("text"), async (ctx) => {
      if (ctx.message.text.startsWith("/")) {
        console.log("Command detected:", ctx.message.text);
        return;
      }
      if (ctx.message.text.startsWith("/")) return;

      try {
        const userId = ctx.from?.id;
        if (!userId || this.isProcessing(userId)) {
          await ctx.reply(
            "Still processing your previous message! Please wait..."
          );
          return;
        }

        this.setProcessing(userId);
        await ctx.sendChatAction("typing");

        const response = await this.messageHandler.handle(
          ctx,
          this.ai.character.id
        );
        if (response) {
          await this.sendResponse(ctx, response);
        }
      } catch (error) {
        await this.handleError(ctx, error);
      } finally {
        if (ctx.from?.id) {
          this.clearProcessing(ctx.from.id);
        }
      }
    });

    this.bot.catch((error: any) => {
      console.error("Telegram bot error:", error);
    });
  }

  private registerCommands() {
    console.log("registering commands");
    this.bot.command("img", async (ctx) => {
      console.log("here");
      const prompt = ctx.message.text.split(" ").slice(1).join(" ").trim();

      if (!prompt) {
        await ctx.reply("Please provide an image description after /img");
        return;
      }

      try {
        await ctx.reply("🎨 Generating your fat duck...");
        await ctx.sendChatAction("upload_photo");
        await this.imageHandler.handleImageGeneration(ctx);
      } catch (error) {
        await this.handleError(ctx, error);
      }
    });

    this.bot.command("help", (ctx) => {
      const helpText = [
        "*Available Commands:*",
        "• `/img <description>` - Generate an image",
        "",
        "*Examples:*",
        "• `/img a serene mountain landscape at sunset`",
      ].join("\n");

      return ctx.reply(helpText, { parse_mode: "Markdown" });
    });

    this.bot.telegram.setMyCommands([
      { command: "img", description: "Generate an image from description" },
      { command: "help", description: "Show available commands" },
    ]);
  }

  private async sendResponse(ctx: Context, text: string) {
    try {
      if (text.length <= this.MAX_MESSAGE_LENGTH) {
        await ctx.reply(text, { parse_mode: "Markdown" });
        return;
      }

      const chunks = this.splitMessage(text);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      await ctx.reply(text.replace(/[*_`\[\]]/g, ""));
    }
  }

  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    const paragraphs = text.split("\n\n");
    for (const paragraph of paragraphs) {
      if (
        currentChunk.length + paragraph.length + 2 <=
        this.MAX_MESSAGE_LENGTH
      ) {
        currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = paragraph;
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  private isProcessing(userId: number): boolean {
    const timestamp = this.processingMessages.get(userId);
    if (!timestamp) return false;
    return Date.now() - timestamp < this.PROCESSING_TIMEOUT;
  }

  private setProcessing(userId: number) {
    this.processingMessages.set(userId, Date.now());
  }

  private clearProcessing(userId: number) {
    this.processingMessages.delete(userId);
  }

  private async handleError(ctx: Context, error: any) {
    console.error("Error handling message:", error);

    let errorMessage = "An error occurred processing your message.";
    if (error.code === "ETIMEDOUT") {
      errorMessage = "Request timed out. Please try again.";
    } else if (error.message?.includes("context length")) {
      errorMessage =
        "Message is too long to process. Please try a shorter message.";
    }

    try {
      await ctx.reply(errorMessage);
    } catch (replyError) {
      console.error("Error sending error message:", replyError);
    }
  }
}
