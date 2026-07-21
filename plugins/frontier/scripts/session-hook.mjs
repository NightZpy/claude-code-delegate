import fs from "node:fs/promises";

async function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return;
  }

  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }

  const payload = text.trim() ? JSON.parse(text) : {};
  const sessionId = payload?.session_id;
  if (!sessionId) {
    return;
  }

  await fs.appendFile(envFile, `\nFRONTIER_SESSION_ID=${sessionId}\n`, "utf8");
}

main().catch(() => {
  process.exitCode = 0;
});
