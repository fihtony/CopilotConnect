import { startBridge } from "./server";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 1288;

console.log("Starting MyBridge in standalone mode (no VS Code integration)");
console.log("Note: /models and /chat will return simulated responses.");
console.log("To get real Copilot responses, run this as a VS Code extension.");

startBridge(port)
  .then((stopFn) => {
    console.log(`MyBridge running (standalone) on port ${port}`);

    process.on("SIGINT", async () => {
      console.log("Stopping MyBridge...");
      await stopFn();
      process.exit(0);
    });
  })
  .catch((err) => {
    console.error("Failed to start bridge:", err);
    process.exit(1);
  });
