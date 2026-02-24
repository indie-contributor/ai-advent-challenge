import { ToolLoopAgent, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import * as readline from "node:readline/promises";

const model = openai("gpt-4o-mini");

const agent = new ToolLoopAgent({
  model,
  instructions: "You are a helpful assistant. Be concise in your responses.",
  stopWhen: stepCountIs(10),
  tools: {
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
  },
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("Agent ready! Type your messages (Ctrl+C to exit)\n");

const messages = [];

while (true) {
  const input = await rl.question("You: ");
  if (!input.trim()) continue;

  messages.push({ role: "user", content: input });

  const result = await agent.generate({ messages });

  // Append all response messages (includes tool call/result pairs) to preserve full context
  messages.push(...result.response.messages);

  console.log(`\nAgent: ${result.text}\n`);
}
