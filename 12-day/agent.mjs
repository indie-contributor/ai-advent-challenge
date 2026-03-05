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
let taskState = null;

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

function trackUsage(usage) {
  const msgIn = usage?.inputTokens ?? 0;
  const msgOut = usage?.outputTokens ?? 0;
  const msgCost = calculateCost(currentModelName, msgIn, msgOut);
  cumulativeInputTokens += msgIn;
  cumulativeOutputTokens += msgOut;
  cumulativeCost += msgCost;
  console.log(`  [Tokens] ${msgIn} in / ${msgOut} out | Cost: $${msgCost.toFixed(4)}`);
}

// --- Task State Machine ---

function getPromptString() {
  if (!taskState) return "You: ";
  if (taskState.paused) {
    const step = taskState.state === "execution"
      ? ` Step ${taskState.currentStep + 1}/${taskState.subtasks.length}`
      : ` ${taskState.state}`;
    return `[PAUSED${step}] You: `;
  }
  return "You: ";
}

async function runPlanning() {
  console.log("\n  === PLANNING ===");
  console.log(`  Task: ${taskState.description}\n`);

  const { text: planText, usage } = await generateText({
    model: openai(currentModelName),
    prompt: `You are a task planner. Given a task description, break it down into sequential subtasks.
Each subtask should be a single, concrete action that can be completed using the available tools (weather lookup, math calculation) or by reasoning.

Task: ${taskState.description}

Respond with ONLY a JSON array of strings, each being a subtask description. Example:
["Get the weather in New York", "Get the weather in London", "Calculate the average of the two temperatures"]`,
  });

  trackUsage(usage);

  const jsonMatch = planText.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const subtaskDescriptions = JSON.parse(jsonMatch[0]);
      taskState.subtasks = subtaskDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending",
        result: null,
      }));
    } catch {
      // fallback to line-based parsing
      const lines = planText.split("\n").map(l => l.replace(/^\d+[\.\)]\s*/, "").trim()).filter(Boolean);
      taskState.subtasks = lines.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending",
        result: null,
      }));
    }
  } else {
    const lines = planText.split("\n").map(l => l.replace(/^\d+[\.\)]\s*/, "").trim()).filter(Boolean);
    taskState.subtasks = lines.map((desc, i) => ({
      id: i + 1,
      description: desc,
      status: "pending",
      result: null,
    }));
  }

  console.log(`\n  Plan (${taskState.subtasks.length} steps):`);
  for (const s of taskState.subtasks) {
    console.log(`    ${s.id}. ${s.description}`);
  }
  console.log();

  taskState.state = "execution";
}

async function runExecution() {
  while (taskState.currentStep < taskState.subtasks.length) {
    if (taskState.paused) return;

    const subtask = taskState.subtasks[taskState.currentStep];
    subtask.status = "in-progress";

    console.log(`  --- [Step ${subtask.id}/${taskState.subtasks.length}] ${subtask.description} ---`);

    const completedSoFar = taskState.subtasks
      .filter(s => s.status === "done")
      .map(s => `  Step ${s.id}: ${s.description} -> ${s.result}`)
      .join("\n");

    taskState.messages.push({
      role: "user",
      content: `You are executing a multi-step task.
Overall task: ${taskState.description}

${completedSoFar ? `Completed steps:\n${completedSoFar}\n` : ""}Current step (${taskState.currentStep + 1}/${taskState.subtasks.length}): ${subtask.description}

Execute this step using the available tools if needed. Be concise. Report only the result.`,
    });

    const result = await agent.generate({ messages: taskState.messages });
    taskState.messages.push(...result.response.messages);

    subtask.result = result.text;
    subtask.status = "done";

    console.log(`  Result: ${result.text}`);
    displayUsage(result);

    taskState.currentStep++;

    // Pause checkpoint between steps
    if (taskState.currentStep < taskState.subtasks.length) {
      const checkpointInput = await readInput("  [Enter=continue, /pause=pause, or type feedback]: ");
      const trimmed = checkpointInput.trim();
      if (trimmed.toLowerCase() === "/pause") {
        taskState.paused = true;
        console.log(`\n  Task paused at step ${taskState.currentStep + 1}/${taskState.subtasks.length}.`);
        console.log("  Type comments (stored for resume) or /resume to continue.\n");
        return;
      }
      if (trimmed) {
        taskState.messages.push({
          role: "user",
          content: `[User feedback after step ${taskState.currentStep}]: ${trimmed}`,
        });
        console.log(`  (Feedback noted, will be considered in next step)\n`);
      }
    }
  }

  taskState.state = "validation";
}

async function runValidation() {
  console.log("  === VALIDATION ===");
  console.log("  Reviewing all results...\n");

  const resultsSummary = taskState.subtasks
    .map(s => `  Step ${s.id}: ${s.description}\n    Result: ${s.result}`)
    .join("\n");

  const { text: validationText, usage } = await generateText({
    model: openai(currentModelName),
    prompt: `You are validating the results of a multi-step task.

Overall task: ${taskState.description}

Results:
${resultsSummary}

Review each step's result. Check:
1. Did each step produce a valid result?
2. Are the results consistent with each other?
3. Does the overall task appear to be completed correctly?

Respond with a brief validation summary.`,
  });

  trackUsage(usage);
  taskState.validationResult = validationText;
  console.log(`\n  Validation: ${validationText}\n`);

  taskState.state = "done";
}

function finishTask() {
  console.log("  === TASK COMPLETE ===");
  console.log(`  Task: ${taskState.description}\n`);

  const resultsSummary = taskState.subtasks
    .map(s => `${s.id}. ${s.description}: ${s.result}`)
    .join("\n");

  const summaryText = `Task completed: "${taskState.description}"\n\nResults:\n${resultsSummary}\n\nValidation: ${taskState.validationResult}`;

  messages.push(
    { role: "user", content: `[Task completed] ${taskState.description}` },
    { role: "assistant", content: summaryText },
  );

  taskState = null;
  console.log("  Ready for next task or conversation.\n");
}

async function runTaskStateMachine() {
  while (taskState && taskState.state !== "done") {
    if (taskState.paused) return;

    switch (taskState.state) {
      case "planning":
        await runPlanning();
        break;
      case "execution":
        await runExecution();
        break;
      case "validation":
        await runValidation();
        break;
    }
  }

  if (taskState?.state === "done") {
    finishTask();
  }
}

// --- End Task State Machine ---

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
      taskState = null;
      cumulativeInputTokens = 0;
      cumulativeOutputTokens = 0;
      cumulativeCost = 0;
      console.log("\n--- New chat started ---\n");
      return true;

    case "/task": {
      const description = parts.slice(1).join(" ");
      if (!description) {
        console.log("\nUsage: /task <description>");
        console.log("Example: /task Check weather in NYC and London, then calculate the average\n");
        return true;
      }
      if (taskState) {
        console.log("\nA task is already active. Use /cancel to cancel it first.\n");
        return true;
      }
      taskState = {
        description,
        state: "planning",
        subtasks: [],
        currentStep: 0,
        paused: false,
        pauseComments: [],
        validationResult: null,
        messages: [],
      };
      await runTaskStateMachine();
      return true;
    }

    case "/pause":
      if (!taskState) {
        console.log("\nNo active task to pause.\n");
      } else if (taskState.paused) {
        console.log("\nTask is already paused.\n");
      } else {
        taskState.paused = true;
        const stateInfo = taskState.state === "execution"
          ? `execution (step ${taskState.currentStep + 1}/${taskState.subtasks.length})`
          : taskState.state;
        console.log(`\nTask paused during ${stateInfo}.`);
        console.log("Type comments (stored for when you resume) or /resume to continue.\n");
      }
      return true;

    case "/resume":
      if (!taskState) {
        console.log("\nNo active task to resume.\n");
      } else if (!taskState.paused) {
        console.log("\nTask is not paused.\n");
      } else {
        taskState.paused = false;
        if (taskState.pauseComments.length > 0) {
          const commentsText = taskState.pauseComments.join("\n");
          taskState.messages.push({
            role: "user",
            content: `[User comments added during pause]:\n${commentsText}\n\nPlease take these into account as you continue.`,
          });
          console.log(`  Injected ${taskState.pauseComments.length} comment(s) into context.`);
          taskState.pauseComments = [];
        }
        console.log("\nResuming task...\n");
        await runTaskStateMachine();
      }
      return true;

    case "/status":
      if (!taskState) {
        console.log("\nNo active task. Use /task <description> to start one.\n");
      } else {
        console.log(`\n  === TASK STATUS ===`);
        console.log(`  Task: ${taskState.description}`);
        console.log(`  State: ${taskState.state}${taskState.paused ? " (PAUSED)" : ""}`);
        if (taskState.subtasks.length > 0) {
          const doneCount = taskState.subtasks.filter(s => s.status === "done").length;
          console.log(`  Progress: ${doneCount}/${taskState.subtasks.length} steps completed`);
          for (const s of taskState.subtasks) {
            const marker = s.status === "done" ? "[x]" : s.status === "in-progress" ? "[>]" : "[ ]";
            const result = s.result ? ` -> ${s.result.slice(0, 60)}${s.result.length > 60 ? "..." : ""}` : "";
            console.log(`    ${marker} ${s.id}. ${s.description}${result}`);
          }
        }
        if (taskState.pauseComments.length > 0) {
          console.log(`  Pending comments: ${taskState.pauseComments.length}`);
        }
        console.log();
      }
      return true;

    case "/cancel":
      if (!taskState) {
        console.log("\nNo active task to cancel.\n");
      } else {
        console.log(`\nTask cancelled: "${taskState.description}"\n`);
        taskState = null;
      }
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
  /task <description>           Start a multi-step task (planning -> execution -> validation -> done)
  /pause                        Pause the current task (type comments while paused)
  /resume                       Resume a paused task (comments injected into context)
  /status                       Show current task state and progress
  /cancel                       Cancel the current task
  /new                          Start a new chat (clears history, tokens & task)
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
async function readInput(prompt = "You: ") {
  const firstLine = await rl.question(prompt);
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
console.log("Use /task <description> to start a multi-step task");
console.log("Type /help for available commands\n");

while (true) {
  const input = await readInput(getPromptString());
  if (!input.trim()) continue;

  if (await handleSlashCommand(input)) continue;

  // If a task is paused, store comments
  if (taskState?.paused) {
    taskState.pauseComments.push(input);
    console.log(`  (Comment stored: "${input.slice(0, 50)}${input.length > 50 ? "..." : ""}")`);
    console.log("  Type /resume to continue or /status to check state.\n");
    continue;
  }

  // If a task is actively running (shouldn't normally reach here, but guard)
  if (taskState) {
    console.log("  Task is running. Use /pause to pause, /status to check progress.\n");
    continue;
  }

  // Normal chat mode
  messages.push({ role: "user", content: input });

  const result = await agent.generate({ messages });

  // Append all response messages (includes tool call/result pairs) to preserve full context
  messages.push(...result.response.messages);

  console.log(`\nAgent: ${result.text}\n`);
  displayUsage(result);
}
