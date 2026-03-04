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

const profiles = {
  default: "You are a helpful assistant. Be concise in your responses.",
};
let currentProfileName = "default";

function createAgent(modelName) {
  return new ToolLoopAgent({
    model: openai(modelName),
    instructions: profiles[currentProfileName],
    stopWhen: stepCountIs(10),
    tools,
  });
}

let currentModelName = "gpt-4o-mini";
let agent = createAgent(currentModelName);
let messages = [];
let cumulativeInputTokens = 0;
let cumulativeOutputTokens = 0;
let cumulativeCost = 0;

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

    case "/profile": {
      const sub = parts[1];
      if (!sub) {
        console.log(`\nCurrent profile: ${currentProfileName}`);
        console.log("Available profiles:");
        for (const name of Object.keys(profiles)) {
          const marker = name === currentProfileName ? " (active)" : "";
          console.log(`  - ${name}${marker}`);
        }
        console.log(`\nUse /profile add|use|show|delete <name>. Type /help for details.\n`);
        return true;
      }

      if (sub === "use") {
        const name = parts[2];
        if (!name || !profiles[name]) {
          console.log(`\nUnknown profile: ${name ?? "(none)"}. Available: ${Object.keys(profiles).join(", ")}\n`);
          return true;
        }
        currentProfileName = name;
        agent = createAgent(currentModelName);
        console.log(`\nSwitched to profile: ${name}\n`);
        return true;
      }

      if (sub === "add") {
        const name = parts[2];
        const description = parts.slice(3).join(" ");
        if (!name || !description) {
          console.log("\nUsage: /profile add <name> <system prompt text>\n");
          return true;
        }
        profiles[name] = description;
        console.log(`\nProfile "${name}" created.\n`);
        return true;
      }

      if (sub === "show") {
        const name = parts[2] ?? currentProfileName;
        if (!profiles[name]) {
          console.log(`\nUnknown profile: ${name}\n`);
          return true;
        }
        console.log(`\n[${name}] ${profiles[name]}\n`);
        return true;
      }

      if (sub === "delete") {
        const name = parts[2];
        if (!name || !profiles[name]) {
          console.log(`\nUnknown profile: ${name ?? "(none)"}\n`);
          return true;
        }
        if (name === "default") {
          console.log("\nCannot delete the default profile.\n");
          return true;
        }
        delete profiles[name];
        if (currentProfileName === name) {
          currentProfileName = "default";
          agent = createAgent(currentModelName);
          console.log(`\nProfile "${name}" deleted. Switched back to default.\n`);
        } else {
          console.log(`\nProfile "${name}" deleted.\n`);
        }
        return true;
      }

      console.log(`\nUnknown subcommand: ${sub}. Use /profile add|use|show|delete <name>.\n`);
      return true;
    }

    case "/help":
      console.log(`
Available commands:
  /new                          Start a new chat (clears history & token counts)
  /compact                      Summarize older messages to free context space
  /model <name>                 Switch model (e.g., /model gpt-4o)
  /model                        Show current model and available models
  /profile                      Show current profile and list all profiles
  /profile use <name>           Switch to a profile
  /profile add <name> <prompt>  Create a profile with a custom system prompt
  /profile show [name]          Show a profile's system prompt
  /profile delete <name>        Delete a profile
  /help                         Show this help message
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

  const result = await agent.generate({ messages });

  // Append all response messages (includes tool call/result pairs) to preserve full context
  messages.push(...result.response.messages);

  console.log(`\nAgent: ${result.text}\n`);
  displayUsage(result);
}
