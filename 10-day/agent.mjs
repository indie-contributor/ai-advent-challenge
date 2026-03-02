import { ToolLoopAgent, tool, stepCountIs, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import * as readline from "node:readline/promises";

// Pricing per 1M tokens + context window size (as of Feb 2026)
const MODEL_PRICING = {
  // GPT-5.x series
  "gpt-5.2":           { input: 1.75,   output: 14.0,  context: 400_000 },
  "gpt-5.2-pro":       { input: 21.0,   output: 168.0, context: 400_000 },
  "gpt-5.1":           { input: 1.25,   output: 10.0,  context: 400_000 },
  "gpt-5.1-codex":     { input: 1.25,   output: 10.0,  context: 400_000 },
  "gpt-5":             { input: 1.25,   output: 10.0,  context: 400_000 },
  "gpt-5-mini":        { input: 0.25,   output: 2.0,   context: 400_000 },
  "gpt-5-nano":        { input: 0.05,   output: 0.4,   context: 400_000 },
  "gpt-5-pro":         { input: 15.0,   output: 120.0, context: 400_000 },
  // GPT-4.1 series
  "gpt-4.1":           { input: 2.0,    output: 8.0,   context: 1_000_000 },
  "gpt-4.1-mini":      { input: 0.4,    output: 1.6,   context: 1_000_000 },
  "gpt-4.1-nano":      { input: 0.1,    output: 0.4,   context: 1_000_000 },
  // GPT-4o series
  "gpt-4o":            { input: 2.5,    output: 10.0,  context: 128_000 },
  "gpt-4o-mini":       { input: 0.15,   output: 0.6,   context: 128_000 },
  // Legacy
  "gpt-4-turbo":       { input: 10.0,   output: 30.0,  context: 128_000 },
  // Reasoning models
  "o4-mini":           { input: 1.1,    output: 4.4,   context: 200_000 },
  "o3":                { input: 2.0,    output: 8.0,   context: 200_000 },
  "o3-mini":           { input: 1.1,    output: 4.4,   context: 200_000 },
  "o3-pro":            { input: 20.0,   output: 80.0,  context: 200_000 },
  "o1":                { input: 15.0,   output: 60.0,  context: 200_000 },
  "o1-pro":            { input: 150.0,  output: 600.0, context: 200_000 },
};

const tools = {
  weather: tool({
    description: "Get the weather in a location (in Fahrenheit)",
    inputSchema: z.object({
      location: z.string().describe("The location to get the weather for"),
    }),
    execute: async ({ location }) => ({
      location,
      temperature: 72 + Math.floor(Math.random() * 21) - 10,
    }),
  }),
  calculate: tool({
    description: "Evaluate a math expression",
    inputSchema: z.object({
      expression: z.string().describe("The math expression to evaluate"),
    }),
    execute: async ({ expression }) => {
      try {
        const result = Function(`"use strict"; return (${expression})`)();
        return { expression, result };
      } catch {
        return { expression, error: "Invalid expression" };
      }
    },
  }),
};

function createAgent(modelName) {
  return new ToolLoopAgent({
    model: openai(modelName),
    instructions: "You are a helpful assistant. Be concise in your responses.",
    stopWhen: stepCountIs(10),
    tools,
  });
}

// --- Context management strategies ---
const FACTS_EXTRACTION_MODEL = "gpt-4o-mini";

const contextStrategies = {
  none: {
    description: "Keep all messages (no trimming)",
    async apply(msgs) {
      return { messages: msgs, kept: msgs.length, removed: 0 };
    },
  },
  "sliding-window": {
    description: "Keep only the last N messages",
    windowSize: 20,
    async apply(msgs) {
      if (msgs.length <= this.windowSize) {
        return { messages: msgs, kept: msgs.length, removed: 0 };
      }
      const removed = msgs.length - this.windowSize;
      return {
        messages: msgs.slice(-this.windowSize),
        kept: this.windowSize,
        removed,
      };
    },
  },
  "sticky-facts": {
    description: "Key-value facts memory + last N messages",
    windowSize: 10,
    facts: {},

    async extractFacts(userMessage) {
      const currentFacts = JSON.stringify(this.facts, null, 2);
      const prompt = `You manage a key-value memory of important facts from a conversation.

Current facts:
${currentFacts}

New user message:
"${userMessage}"

Based on the new message, update the facts object.
- Add new facts discovered in the message
- Update existing facts if the message changes them
- Remove facts that are explicitly invalidated
- Facts should capture: user goals, constraints, preferences, decisions, agreements, names, important context
- Keep keys short and descriptive (camelCase)
- Keep values concise (one sentence max)
- If nothing new to extract, return current facts unchanged

Return ONLY a valid JSON object. No markdown, no explanation.`;

      try {
        const { text } = await generateText({
          model: openai(FACTS_EXTRACTION_MODEL),
          prompt,
        });
        const parsed = JSON.parse(text.trim());
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          this.facts = parsed;
        }
      } catch (e) {
        console.log(`  [sticky-facts] Fact extraction failed: ${e.message}`);
      }
    },

    async apply(msgs) {
      // Extract facts from the latest user message
      const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        const userText =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : (lastUserMsg.content ?? [])
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(" ");
        if (userText.trim()) {
          await this.extractFacts(userText);
        }
      }

      // Sliding window on raw messages
      const windowMsgs =
        msgs.length <= this.windowSize ? msgs : msgs.slice(-this.windowSize);
      const removed = msgs.length - windowMsgs.length;

      // Prepend facts as a system-like user message for the model
      const entries = Object.entries(this.facts);
      const messagesToSend = [...windowMsgs];
      if (entries.length > 0) {
        const factsText = entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
        messagesToSend.unshift({
          role: "user",
          content: `[Memory — known facts about this conversation]\n${factsText}\n[End of memory]`,
        });
      }

      return {
        messages: messagesToSend,
        trimmedMessages: windowMsgs,
        kept: windowMsgs.length,
        removed,
        factsCount: entries.length,
      };
    },
  },
};

let currentStrategy = "none";

async function applyContextStrategy(msgs) {
  const strategy = contextStrategies[currentStrategy];
  const result = await strategy.apply(msgs);

  const parts = [];
  if (result.removed > 0) {
    parts.push(`kept ${result.kept} messages, removed ${result.removed} older`);
  } else {
    parts.push(`keeping all ${result.kept} messages`);
  }
  if (result.factsCount !== undefined) {
    parts.push(`${result.factsCount} facts in memory`);
  }
  console.log(`  [Context Strategy: ${currentStrategy}] ${parts.join(" | ")}`);

  // trimmedMessages = raw conversation messages after windowing (stored back)
  // messagesToSend  = what actually goes to the model (may include facts preamble)
  const trimmedMessages = result.trimmedMessages ?? result.messages;
  return { messagesToSend: result.messages, trimmedMessages };
}

let currentModelName = "gpt-4o-mini";
let agent = createAgent(currentModelName);
let messages = [];
let cumulativeInputTokens = 0;
let cumulativeOutputTokens = 0;
let cumulativeCost = 0;

// --- Branching state ---
let checkpoints = {};          // { name -> deep-copied messages[] }
let branches = {};             // { name -> messages[] }
let currentBranch = null;      // null = unnamed "main" timeline
let lastCheckpointName = null; // most recent checkpoint name

function calculateCost(modelName, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[modelName];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;
}

// Estimate token count from messages array (~4 chars per token for GPT models)
function estimateTokens(msgs) {
  let chars = 0;
  for (const msg of msgs) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") chars += part.text.length;
        else if (part.type === "tool-call") chars += JSON.stringify(part.args ?? {}).length;
      }
    }
    chars += 4; // per-message overhead (role, separators)
  }
  return Math.ceil(chars / 4);
}

function displayUsage(result) {
  const totalUsage = result.totalUsage;
  const msgIn = totalUsage.inputTokens ?? 0;
  const msgOut = totalUsage.outputTokens ?? 0;
  const msgCost = calculateCost(currentModelName, msgIn, msgOut);

  cumulativeInputTokens += msgIn;
  cumulativeOutputTokens += msgOut;
  cumulativeCost += msgCost;

  const pricing = MODEL_PRICING[currentModelName];
  const contextWindow = pricing?.context ?? 128_000;
  const contextTokens = estimateTokens(messages);
  const contextPct = ((contextTokens / contextWindow) * 100).toFixed(1);

  const totalTokens = cumulativeInputTokens + cumulativeOutputTokens;

  console.log(
    `  [Context] ~${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (~${contextPct}%)`
  );
  console.log(
    `  [Tokens]  this: ${msgIn} in / ${msgOut} out | ` +
    `total: ${totalTokens} (${cumulativeInputTokens} in / ${cumulativeOutputTokens} out)`
  );
  console.log(
    `  [Cost]    this: $${msgCost.toFixed(4)} | total: $${cumulativeCost.toFixed(4)} (${currentModelName})`
  );
  console.log();
}

async function compactMessages() {
  if (messages.length <= 5) {
    console.log("\nNothing to compact (5 or fewer messages).\n");
    return;
  }

  const olderMessages = messages.slice(0, -5);
  const recentMessages = messages.slice(-5);

  // Extract readable text from older messages for summarization
  const transcript = olderMessages.map((msg) => {
    const role = msg.role ?? "unknown";
    if (typeof msg.content === "string") return `${role}: ${msg.content}`;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ");
      if (text) return `${role}: ${text}`;
    }
    return null;
  }).filter(Boolean).join("\n");

  if (!transcript.trim()) {
    console.log("\nNo text content to summarize.\n");
    return;
  }

  console.log("\nCompacting conversation...");
  const beforeCount = messages.length;

  const { text: summary } = await generateText({
    model: openai(currentModelName),
    prompt: `Summarize the following conversation concisely, preserving key facts, decisions, and context that would be needed to continue the conversation:\n\n${transcript}`,
  });

  messages = [
    { role: "user", content: `Summary of prior conversation:\n${summary}` },
    { role: "assistant", content: "Understood, I have the context from our previous conversation." },
    ...recentMessages,
  ];

  const afterCount = messages.length;
  console.log(`Compacted: ${beforeCount} messages → ${afterCount} messages (${beforeCount - afterCount} removed)\n`);
}

async function handleSlashCommand(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/new":
      messages = [];
      cumulativeInputTokens = 0;
      cumulativeOutputTokens = 0;
      cumulativeCost = 0;
      contextStrategies["sticky-facts"].facts = {};
      checkpoints = {};
      branches = {};
      currentBranch = null;
      lastCheckpointName = null;
      console.log("\n--- New chat started ---\n");
      return true;

    case "/model": {
      const newModel = parts[1];
      if (!newModel) {
        console.log(`\nCurrent model: ${currentModelName}`);
        console.log(`Available: ${Object.keys(MODEL_PRICING).join(", ")}\n`);
        return true;
      }
      currentModelName = newModel;
      agent = createAgent(currentModelName);
      const note = MODEL_PRICING[currentModelName] ? "" : " (no pricing data, cost will show as $0.00)";
      console.log(`\nSwitched to model: ${currentModelName}${note}\n`);
      return true;
    }

    case "/compact":
      await compactMessages();
      return true;

    case "/context": {
      const subCmd = parts[1];
      if (!subCmd) {
        const strategy = contextStrategies[currentStrategy];
        console.log(`\nCurrent context strategy: ${currentStrategy} — ${strategy.description}`);
        if (strategy.windowSize !== undefined) {
          console.log(`  Window size: ${strategy.windowSize}`);
        }
        console.log(`Available strategies: ${Object.keys(contextStrategies).join(", ")}\n`);
        return true;
      }
      if (subCmd in contextStrategies) {
        currentStrategy = subCmd;
        const arg = parts[2];
        const strategy = contextStrategies[currentStrategy];
        if (strategy.windowSize !== undefined && arg) {
          const n = parseInt(arg, 10);
          if (n > 0) strategy.windowSize = n;
        }
        let info = `\nSwitched to context strategy: ${currentStrategy} — ${strategy.description}`;
        if (strategy.windowSize !== undefined) {
          info += ` (window: ${strategy.windowSize})`;
        }
        console.log(info + "\n");
        return true;
      }
      console.log(`\nUnknown strategy: ${subCmd}. Available: ${Object.keys(contextStrategies).join(", ")}\n`);
      return true;
    }

    case "/facts": {
      const subCmd = parts[1];
      const stickyFacts = contextStrategies["sticky-facts"];
      if (subCmd === "clear") {
        stickyFacts.facts = {};
        console.log("\nFacts cleared.\n");
        return true;
      }
      const entries = Object.entries(stickyFacts.facts);
      if (entries.length === 0) {
        console.log("\nNo facts stored yet.\n");
      } else {
        console.log(`\nStored facts (${entries.length}):`);
        for (const [k, v] of entries) {
          console.log(`  ${k}: ${v}`);
        }
        console.log();
      }
      return true;
    }

    case "/checkpoint": {
      const name = parts[1] || `cp-${Date.now()}`;
      const overwriting = checkpoints[name] ? " (overwriting existing)" : "";
      checkpoints[name] = JSON.parse(JSON.stringify(messages));
      lastCheckpointName = name;
      console.log(`\n  [Checkpoint] Saved "${name}" (${messages.length} messages)${overwriting}\n`);
      return true;
    }

    case "/branch": {
      const name = parts[1];
      if (!name) {
        console.log("\n  Usage: /branch <name>\n");
        return true;
      }
      if (branches[name]) {
        console.log(`\n  Branch "${name}" already exists. Use /switch ${name} to switch to it.\n`);
        return true;
      }
      if (!lastCheckpointName || !checkpoints[lastCheckpointName]) {
        console.log("\n  No checkpoint found. Run /checkpoint [name] first.\n");
        return true;
      }

      // Auto-save current branch before switching
      const saveName = currentBranch ?? "main";
      branches[saveName] = messages;

      // Fork from the last checkpoint
      const forkedMessages = JSON.parse(JSON.stringify(checkpoints[lastCheckpointName]));
      branches[name] = forkedMessages;
      messages = forkedMessages;
      currentBranch = name;

      console.log(`\n  [Branch] Created "${name}" from checkpoint "${lastCheckpointName}" (${forkedMessages.length} messages)`);
      console.log(`  [Branch] Switched to "${name}"\n`);
      return true;
    }

    case "/switch": {
      const name = parts[1];
      if (!name) {
        console.log("\n  Usage: /switch <branch>\n");
        return true;
      }
      if (name === currentBranch || (name === "main" && currentBranch === null)) {
        console.log(`\n  Already on branch "${name}".\n`);
        return true;
      }
      if (!branches[name]) {
        console.log(`\n  Branch "${name}" not found. Run /branches to see available branches.\n`);
        return true;
      }

      // Auto-save current branch
      const saveAs = currentBranch ?? "main";
      branches[saveAs] = messages;
      console.log(`  [Branch] Saved "${saveAs}" (${messages.length} messages)`);

      // Load target branch
      messages = branches[name];
      currentBranch = name === "main" ? null : name;
      console.log(`  [Branch] Switched to "${name}" (${messages.length} messages)\n`);
      return true;
    }

    case "/branches": {
      const allBranches = Object.keys(branches);
      if (allBranches.length === 0 && currentBranch === null) {
        console.log("\n  No branches yet. Use /checkpoint then /branch <name> to create one.\n");
        return true;
      }

      const activeName = currentBranch ?? "main";
      console.log("\n  Branches:");
      // Show current unsaved state for active branch
      if (!allBranches.includes(activeName)) {
        console.log(`    ${activeName} (${messages.length} messages) *`);
      }
      for (const name of allBranches) {
        const marker = name === activeName ? " *" : "";
        const count = name === activeName ? messages.length : branches[name].length;
        console.log(`    ${name} (${count} messages)${marker}`);
      }

      const cpNames = Object.keys(checkpoints);
      if (cpNames.length > 0) {
        console.log("  Checkpoints:");
        for (const name of cpNames) {
          const marker = name === lastCheckpointName ? " (latest)" : "";
          console.log(`    ${name} (${checkpoints[name].length} messages)${marker}`);
        }
      }
      console.log();
      return true;
    }

    case "/help":
      console.log(`
Available commands:
  /new                          Start a new chat (clears history & token counts)
  /compact                      Summarize older messages to free context space
  /context                      Show current context strategy
  /context <strategy> [N]       Switch strategy (e.g., /context sticky-facts 10)
  /facts                        Show stored facts (sticky-facts strategy)
  /facts clear                  Clear all stored facts
  /checkpoint [name]            Save a checkpoint of current conversation
  /branch <name>                Create a new branch from last checkpoint
  /switch <branch>              Switch to a different branch (auto-saves current)
  /branches                     List all branches and checkpoints
  /model <name>                 Switch model (e.g., /model gpt-4o)
  /model                        Show current model and available models
  /help                         Show this help message

Context strategies: ${Object.entries(contextStrategies).map(([k, v]) => `${k} (${v.description})`).join(", ")}
`);
      return true;

    default:
      console.log(`\nUnknown command: ${cmd}. Type /help for available commands.\n`);
      return true;
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Buffer rapid lines (e.g. multi-line paste) into a single input
async function readInput() {
  const firstLine = await rl.question("You: ");
  // Collect any remaining pasted lines that arrive within 50ms
  return new Promise((resolve) => {
    const lines = [firstLine];
    let timer = null;

    const onLine = (line) => {
      lines.push(line);
      clearTimeout(timer);
      timer = setTimeout(flush, 50);
    };

    const flush = () => {
      rl.removeListener("line", onLine);
      resolve(lines.join("\n"));
    };

    timer = setTimeout(flush, 50);
    rl.on("line", onLine);
  });
}

console.log("Agent ready! Type your messages (Ctrl+C to exit)");
console.log("Type /help for available commands\n");

while (true) {
  const input = await readInput();
  if (!input.trim()) continue;

  if (await handleSlashCommand(input)) continue;

  messages.push({ role: "user", content: input });

  // Apply context strategy — trim messages and build what gets sent to the model
  const { messagesToSend, trimmedMessages } = await applyContextStrategy(messages);
  // Update stored messages (dropped messages are gone)
  messages = trimmedMessages;

  const result = await agent.generate({ messages: messagesToSend });

  // Append all response messages (includes tool call/result pairs) to preserve full context
  messages.push(...result.response.messages);

  console.log(`\nAgent: ${result.text}\n`);
  displayUsage(result);
}
