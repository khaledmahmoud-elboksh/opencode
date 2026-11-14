// Ported from opencode-autotitle (V1) to the OpenCode V2 plugin API.
//
// Generates session titles: keyword-based titles from the first user message,
// optionally refined by an AI title generated with the cheapest available
// model. Implemented on top of the V2 `session.hook("title")` hook, which
// replaces the model's title request when `event.result` is set.
//
// Configuration (environment, as in the original):
//   OPENCODE_AUTOTITLE_DISABLED=1     disable the plugin
//   OPENCODE_AUTOTITLE_MODEL=<id>     force a specific model ID
//   OPENCODE_AUTOTITLE_PROVIDER=<id>  force a specific provider ID
//   OPENCODE_AUTOTITLE_MAX_LENGTH=60  title length cap
//   OPENCODE_AUTOTITLE_DEBUG=1        verbose logging
import { Plugin } from "@opencode/plugin"

const EMOJI_KEYWORD = "⚡"; // quick keyword-based titles
const EMOJI_AI = "🤖"; // AI-generated titles

// Known cheap/fast model patterns - ordered by preference.
// Priority: fast (often free) > flash (very cheap) > haiku (cheap) > other cheap patterns
const CHEAP_MODEL_PATTERNS = [
  /fast/i,
  /flash/i,
  /haiku/i,
  /mini/i,
  /instant/i,
  /small/i,
  /lite/i,
  /turbo/i,
  /8b/i,
  /7b/i,
];

interface AutotitleConfig {
  model: string | null;
  provider: string | null;
  maxLength: number;
  disabled: boolean;
  debug: boolean;
}

function loadConfig(): AutotitleConfig {
  const env = process.env;
  return {
    model: env.OPENCODE_AUTOTITLE_MODEL || null,
    provider: env.OPENCODE_AUTOTITLE_PROVIDER || null,
    maxLength: Number(env.OPENCODE_AUTOTITLE_MAX_LENGTH) || 60,
    disabled: env.OPENCODE_AUTOTITLE_DISABLED === "1" || env.OPENCODE_AUTOTITLE_DISABLED === "true",
    debug: env.OPENCODE_AUTOTITLE_DEBUG === "1" || env.OPENCODE_AUTOTITLE_DEBUG === "true",
  };
}

interface Logger {
  debug(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

function createLogger(debug: boolean, title: string): Logger {
  const prefix = `[opencode-autotitle:${title}]`;
  return {
    debug: (m) => {
      if (debug) console.log(`${prefix} ${m}`);
    },
    info: (m) => console.info(`${prefix} ${m}`),
    error: (m) => console.error(`${prefix} ${m}`),
  };
}

const TIMESTAMP_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}/,
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i,
  /^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i,
  /^Session\s+\d+/i,
  /^New\s+Session/i,
  /^Untitled/i,
];

function isTimestampTitle(title: string | undefined): boolean {
  if (!title) return true;
  if (title.trim() === "") return true;
  return TIMESTAMP_PATTERNS.some((pattern) => pattern.test(title.trim()));
}

function hasPluginEmoji(title: string | undefined): boolean {
  if (!title) return false;
  return title.startsWith(EMOJI_KEYWORD) || title.startsWith(EMOJI_AI);
}

function shouldModifyTitle(title: string | undefined): boolean {
  return isTimestampTitle(title) || hasPluginEmoji(title);
}

function sanitizeTitle(title: string, maxLength: number): string {
  return title
    .replace(/[^\w\s.\-]/g, "") // Keep dots for filenames like AGENTS.md
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "dare",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "under", "again", "further", "then", "once", "here",
    "there", "when", "where", "why", "how", "all", "each", "few",
    "more", "most", "other", "some", "such", "no", "nor", "not",
    "only", "own", "same", "so", "than", "too", "very", "just",
    "and", "but", "if", "or", "because", "until", "while", "this",
    "that", "these", "those", "i", "me", "my", "myself", "we", "our",
    "you", "your", "he", "him", "his", "she", "her", "it", "its",
    "they", "them", "their", "what", "which", "who", "whom", "please",
    "help", "want", "like", "make", "create", "write", "add", "get",
    "came", "come", "goes", "going", "went", "give", "gave", "take", "took",
    "put", "see", "saw", "know", "knew", "think", "thought", "tell", "told",
    "ask", "asked", "use", "used", "find", "found", "let", "try", "tried",
    "look", "looking", "need", "needed", "seem", "seemed", "work", "working",
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
  const seen = new Set<string>();
  const uniqueWords: string[] = [];
  for (const word of words) {
    if (!seen.has(word)) {
      seen.add(word);
      uniqueWords.push(word);
    }
  }
  return uniqueWords.slice(0, 6);
}

function generateFallbackTitle(text: string, maxLength: number): string {
  const keywords = extractKeywords(text);
  const cleanedText = text.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (cleanedText.length <= maxLength && cleanedText.length > 3) {
    return cleanedText
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  if (keywords.length === 0) return "";
  let title = "";
  for (const keyword of keywords) {
    const capitalized = keyword.charAt(0).toUpperCase() + keyword.slice(1);
    const potential = title ? `${title} ${capitalized}` : capitalized;
    if (potential.length <= maxLength) {
      title = potential;
    } else {
      break;
    }
  }
  return sanitizeTitle(title, maxLength);
}

function extractFirstUserText(messages: readonly unknown[]): string | null {
  for (const message of messages) {
    const m = message as { role?: string; info?: { role?: string }; parts?: readonly unknown[] };
    const role = m?.role ?? m?.info?.role;
    if (role !== "user") continue;
    for (const part of m?.parts ?? []) {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text" && typeof p?.text === "string" && p.text.trim()) {
        return p.text;
      }
    }
    const content = (m as { content?: unknown; text?: unknown }).content ?? (m as { text?: unknown }).text;
    if (typeof content === "string" && content.trim()) return content;
  }
  return null;
}

interface ModelRefLike {
  providerID: string;
  id: string;
}

export default Plugin.define({
  id: "autotitle",
  async setup(ctx) {
    const config = loadConfig();
    if (config.disabled) {
      console.info("[opencode-autotitle] Plugin is disabled via OPENCODE_AUTOTITLE_DISABLED");
      return;
    }
    const log = createLogger(config.debug, "title");

    async function findCheapModel(): Promise<ModelRefLike | null> {
      // Explicit env override wins.
      if (config.model && config.provider) {
        return { providerID: config.provider, id: config.model };
      }
      try {
        const models = await ctx.model.list();
        // 1. Pattern-matched cheap model IDs, in priority order.
        for (const pattern of CHEAP_MODEL_PATTERNS) {
          const match = models.find((m) => pattern.test(m.id) && (!config.model || m.id === config.model));
          if (match) {
            log.debug(`Pattern-matched cheap model: ${match.providerID}/${match.id}`);
            return { providerID: match.providerID, id: match.id };
          }
        }
        if (config.model) {
          const forced = models.find((m) => m.id === config.model);
          if (forced) return { providerID: forced.providerID, id: forced.id };
        }
        // 2. Fall back to the model with the lowest output cost.
        let cheapest: ModelRefLike | null = null;
        let cheapestCost = Number.POSITIVE_INFINITY;
        for (const m of models) {
          const outputCost = m.cost?.[0]?.output ?? Number.POSITIVE_INFINITY;
          if (outputCost < cheapestCost) {
            cheapestCost = outputCost;
            cheapest = { providerID: m.providerID, id: m.id };
          }
        }
        if (cheapest) log.debug(`Cheapest model by cost: ${cheapest.providerID}/${cheapest.id}`);
        return cheapest;
      } catch (e) {
        log.debug(`Failed to find cheap model: ${e instanceof Error ? e.message : "unknown"}`);
        return null;
      }
    }

    async function generateAITitle(
      userMessage: string,
      log: Logger,
    ): Promise<string | null> {
      const model = await findCheapModel();
      const prompt = `Generate a concise, specific title (3-6 words) for this conversation:

User asked: "${userMessage.slice(0, 300)}"

Rules:
- MUST NOT exceed ${config.maxLength} characters - this is a hard limit
- No quotes or special punctuation (but keep dots in filenames like AGENTS.md, package.json)
- Use title case
- Be SPECIFIC about the actual content discussed (e.g., "British Shorthair Cat Photo" not "Image Identification")
- If the response mentions specific things (names, technologies, animals, etc.), include them
- If there's a ticket/issue reference (JIRA like ABC-123, GitHub PR #123, Trello, Linear, etc.), include it as a prefix (e.g., "ABC-123 Fix Login Bug")
- Return ONLY the title, nothing else`;
      try {
        const generation = ctx.experimental.generate.text({
          ...(model ? { model: { providerID: model.providerID, id: model.id } } : {}),
          prompt,
        } as Parameters<typeof ctx.experimental.generate.text>[0]);
        // Keep title generation bounded so it cannot stall the request.
        const result = await Promise.race([
          generation,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("AI title generation timed out")), 45_000),
          ),
        ]);
        const text = (result as { text?: string }).text?.trim();
        if (!text) {
          log.debug("Empty AI title response");
          return null;
        }
        const lines = text.split("\n").filter((l) => l.trim());
        const candidate = lines[0] || text;
        if (candidate.length > 0 && candidate.length <= config.maxLength + 20) {
          return sanitizeTitle(candidate, config.maxLength);
        }
        log.debug(`AI title candidate rejected: ${candidate.slice(0, 80)}`);
      } catch (e) {
        log.debug(`AI generation failed: ${e instanceof Error ? e.message : "unknown"}`);
      }
      return null;
    }

    await ctx.session.hook("title", (event) => {
      return (async () => {
        try {
          // Never overwrite custom titles the user (or another plugin) set.
          let currentTitle: string | undefined;
          try {
            const session = await ctx.session.get({ sessionID: event.sessionID });
            currentTitle = (session as { title?: string } | undefined)?.title;
          } catch {}
          if (!shouldModifyTitle(currentTitle)) {
            log.debug(`Session ${event.sessionID} has custom title, skipping: ${currentTitle}`);
            return;
          }
          const userText = extractFirstUserText(event.messages);
          if (!userText) {
            log.debug(`No user message found for session ${event.sessionID}`);
            return;
          }
          const aiTitle = await generateAITitle(userText, log);
          if (aiTitle) {
            event.result = `${EMOJI_AI} ${aiTitle}`;
            log.info(`Set AI title: ${event.result}`);
            return;
          }
          // Keyword fallback, as in the original's fast phase.
          const keywordTitle = generateFallbackTitle(userText, config.maxLength - 2);
          if (keywordTitle) {
            event.result = `${EMOJI_KEYWORD} ${keywordTitle}`;
            log.info(`Set keyword title: ${event.result}`);
          } else {
            log.debug(`Could not generate a title for session ${event.sessionID}`);
          }
        } catch (err) {
          log.error(`Failed to generate title: ${err instanceof Error ? err.message : "unknown"}`);
        }
      })();
    });

    log.info("AutoTitle plugin initialized (OpenCode V2 port)");
  },
});
