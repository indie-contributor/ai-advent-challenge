import { ToolLoopAgent, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import * as readline from "node:readline/promises";

// Pricing per 1M tokens (as of Feb 2026)
const MODEL_PRICING = {
  // GPT-5.x series
  "gpt-5.2":           { input: 1.75,   output: 14.0 },
  "gpt-5.2-pro":       { input: 21.0,   output: 168.0 },
  "gpt-5.1":           { input: 1.25,   output: 10.0 },
  "gpt-5.1-codex":     { input: 1.25,   output: 10.0 },
  "gpt-5":             { input: 1.25,   output: 10.0 },
  "gpt-5-mini":        { input: 0.25,   output: 2.0 },
  "gpt-5-nano":        { input: 0.05,   output: 0.4 },
  "gpt-5-pro":         { input: 15.0,   output: 120.0 },
  // GPT-4.1 series
  "gpt-4.1":           { input: 2.0,    output: 8.0 },
  "gpt-4.1-mini":      { input: 0.4,    output: 1.6 },
  "gpt-4.1-nano":      { input: 0.1,    output: 0.4 },
  // GPT-4o series
  "gpt-4o":            { input: 2.5,    output: 10.0 },
  "gpt-4o-mini":       { input: 0.15,   output: 0.6 },
  // Legacy
  "gpt-4-turbo":       { input: 10.0,   output: 30.0 },
  // Reasoning models
  "o4-mini":           { input: 1.1,    output: 4.4 },
  "o3":                { input: 2.0,    output: 8.0 },
  "o3-mini":           { input: 1.1,    output: 4.4 },
  "o3-pro":            { input: 20.0,   output: 80.0 },
  "o1":                { input: 15.0,   output: 60.0 },
  "o1-pro":            { input: 150.0,  output: 600.0 },
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

function displayUsage(totalUsage) {
  const msgIn = totalUsage.inputTokens ?? 0;
  const msgOut = totalUsage.outputTokens ?? 0;
  const msgCost = calculateCost(currentModelName, msgIn, msgOut);

  cumulativeInputTokens += msgIn;
  cumulativeOutputTokens += msgOut;
  cumulativeCost += msgCost;

  const totalTokens = cumulativeInputTokens + cumulativeOutputTokens;

  console.log(
    `  [Tokens] this: ${msgIn} in / ${msgOut} out | ` +
    `total: ${totalTokens} (${cumulativeInputTokens} in / ${cumulativeOutputTokens} out)`
  );
  console.log(
    `  [Cost]   this: $${msgCost.toFixed(4)} | total: $${cumulativeCost.toFixed(4)} (${currentModelName})`
  );
  console.log();
}

function handleSlashCommand(input) {
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

    case "/help":
      console.log(`
Available commands:
  /new              Start a new chat (clears history & token counts)
  /model <name>     Switch model (e.g., /model gpt-4o)
  /model            Show current model and available models
  /help             Show this help message
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

console.log("Agent ready! Type your messages (Ctrl+C to exit)");
console.log("Type /help for available commands\n");

while (true) {
  const input = await rl.question("You: ");
  if (!input.trim()) continue;

  if (handleSlashCommand(input)) continue;

  messages.push({ role: "user", content: input });

  const result = await agent.generate({ messages });

  // Append all response messages (includes tool call/result pairs) to preserve full context
  messages.push(...result.response.messages);

  console.log(`\nAgent: ${result.text}\n`);
  displayUsage(result.totalUsage);
}
