import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function main() {
  console.log("daily-ai-agents initialized");

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello! Are you ready to help me automate my workflow?" }],
  });

  console.log(message.content[0]);
}

main().catch(console.error);
